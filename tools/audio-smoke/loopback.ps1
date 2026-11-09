# WASAPI loopback capture of the default render device (what every app plays), written as a 16-bit mono WAV.
# Own code against the Windows Core Audio COM API; installs nothing.  Usage: loopback.ps1 -Out file.wav -Seconds 4
param([string]$Out = "loopback.wav", [double]$Seconds = 4)
Add-Type -TypeDefinition @"
using System; using System.IO; using System.Runtime.InteropServices; using System.Threading;
public static class Loopback {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int NotImpl1(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
  [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioClient {
    int Initialize(int mode, int flags, long bufDur, long period, IntPtr fmt, IntPtr session);
    int GetBufferSize(out uint n); int GetStreamLatency(out long l); int GetCurrentPadding(out uint p);
    int IsFormatSupported(int m, IntPtr f, out IntPtr c); int GetMixFormat(out IntPtr f); int GetDevicePeriod(out long a, out long b);
    int Start(); int Stop(); int Reset(); int SetEventHandle(IntPtr h); int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  }
  [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioCaptureClient {
    int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong p1, out ulong p2);
    int ReleaseBuffer(uint frames); int GetNextPacketSize(out uint frames);
  }
  public static string Run(string path, double seconds) {
    var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
    IMMDevice dev; Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
    var iidClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"); object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iidClient, 23, IntPtr.Zero, out o));
    var client = (IAudioClient)o; IntPtr fmt; Marshal.ThrowExceptionForHR(client.GetMixFormat(out fmt));
    int tag = Marshal.ReadInt16(fmt, 0), ch = Marshal.ReadInt16(fmt, 2), rate = Marshal.ReadInt32(fmt, 4), bits = Marshal.ReadInt16(fmt, 14);
    // AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000, shared mode, 1 s buffer.
    Marshal.ThrowExceptionForHR(client.Initialize(0, 0x00020000, 10000000, 0, fmt, IntPtr.Zero));
    var iidCap = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"); object c;
    Marshal.ThrowExceptionForHR(client.GetService(ref iidCap, out c)); var cap = (IAudioCaptureClient)c;
    var samples = new System.Collections.Generic.List<short>();
    client.Start(); var end = DateTime.UtcNow.AddSeconds(seconds); long silentFlagFrames = 0;
    while (DateTime.UtcNow < end) {
      uint n; cap.GetNextPacketSize(out n);
      while (n > 0) {
        IntPtr d; uint fr, fl; ulong a, b; cap.GetBuffer(out d, out fr, out fl, out a, out b);
        for (int i = 0; i < fr; i++) {
          double s = 0;
          for (int k = 0; k < ch; k++) {
            if ((fl & 2) != 0) { continue; }  // AUDCLNT_BUFFERFLAGS_SILENT
            s += bits == 32 ? BitConverter.ToSingle(BitConverter2(d, (i * ch + k) * 4), 0) : Marshal.ReadInt16(d, (i * ch + k) * 2) / 32768.0;
          }
          s /= ch; if (s > 1) s = 1; if (s < -1) s = -1; samples.Add((short)(s * 32767));
        }
        if ((fl & 2) != 0) silentFlagFrames += fr;
        cap.ReleaseBuffer(fr); cap.GetNextPacketSize(out n);
      }
      Thread.Sleep(10);
    }
    client.Stop();
    using (var f = new BinaryWriter(File.Create(path))) {
      int bytes = samples.Count * 2;
      f.Write(new[]{'R','I','F','F'}); f.Write(36 + bytes); f.Write(new[]{'W','A','V','E','f','m','t',' '}); f.Write(16); f.Write((short)1); f.Write((short)1);
      f.Write(rate); f.Write(rate * 2); f.Write((short)2); f.Write((short)16); f.Write(new[]{'d','a','t','a'}); f.Write(bytes);
      foreach (var s in samples) f.Write(s);
    }
    return "mix format tag " + tag + " ch " + ch + " rate " + rate + " bits " + bits + "; frames " + samples.Count + " (flagged silent " + silentFlagFrames + ")";
  }
  static byte[] BitConverter2(IntPtr p, int off) { var b = new byte[4]; Marshal.Copy(IntPtr.Add(p, off), b, 0, 4); return b; }
}
"@
[Loopback]::Run((Join-Path (Get-Location) $Out), $Seconds)
