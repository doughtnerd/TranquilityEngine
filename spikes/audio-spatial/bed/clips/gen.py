#!/usr/bin/env python3
"""Generates the test files for the symphonia probe into out/.
Channel c of every file carries the constant (c + 1) / 40 (so the order a decoder returns is
readable from the first frame), for 4800 frames at 48 kHz."""
import struct, os, subprocess, sys
os.makedirs('out', exist_ok=True)
FR = 4800
GUID_PCM = bytes.fromhex('0100000000001000800000aa00389b71')
GUID_FLOAT = bytes.fromhex('0300000000001000800000aa00389b71')
GUID_AMB_PCM = bytes.fromhex('0100000021 07d311 8644 c8c1ca000000'.replace(' ', ''))   # AMBISONIC_B_FORMAT_PCM
GUID_AMB_FLOAT = bytes.fromhex('0300000021 07d311 8644 c8c1ca000000'.replace(' ', ''))

def samples(n, kind):
    out = bytearray()
    for _ in range(FR):
        for c in range(n):
            v = (c + 1) / 40.0
            out += struct.pack('<h', int(v * 32767)) if kind == 'pcm16' else struct.pack('<f', v)
    return bytes(out)

def wav(path, n, kind, ext=None, mask=0):
    bits = 16 if kind == 'pcm16' else 32
    data = samples(n, kind)
    if ext is None:
        fmt = struct.pack('<HHIIHH', 1 if kind == 'pcm16' else 3, n, 48000, 48000 * n * bits // 8, n * bits // 8, bits)
    else:
        fmt = struct.pack('<HHIIHHHHI', 0xFFFE, n, 48000, 48000 * n * bits // 8, n * bits // 8, bits, 22, bits, mask) + ext
    body = b'WAVE' + b'fmt ' + struct.pack('<I', len(fmt)) + fmt + b'data' + struct.pack('<I', len(data)) + data
    open(path, 'wb').write(b'RIFF' + struct.pack('<I', len(body)) + body)

for n in (4, 16):
    wav(f'out/{n}ch_pcm16_tag1.wav', n, 'pcm16')
    wav(f'out/{n}ch_f32_tag3.wav', n, 'f32')
    wav(f'out/{n}ch_pcm16_ext_mask0.wav', n, 'pcm16', GUID_PCM, 0)
    wav(f'out/{n}ch_f32_ext_mask0.wav', n, 'f32', GUID_FLOAT, 0)
    wav(f'out/{n}ch_pcm16_ext_ambisonic.wav', n, 'pcm16', GUID_AMB_PCM, 0)
    wav(f'out/{n}ch_f32_ext_ambisonic.wav', n, 'f32', GUID_AMB_FLOAT, 0)

# Ogg Opus. ffmpeg's libopus wrapper only writes mapping families 0, 1 and 255, so make a family-255
# stream with ffmpeg, then rewrite its OpusHead to family 2 (ambisonics, RFC 8486; the channel
# mapping table stays) and fix the page CRC. Family 3 (projection) needs a demixing matrix in the
# header: written here with an identity-like 16-bit matrix of the right size (header-level test only).
def crc_table():
    t = []
    for i in range(256):
        r = i << 24
        for _ in range(8):
            r = ((r << 1) ^ 0x04C11DB7) if r & 0x80000000 else (r << 1)
            r &= 0xFFFFFFFF
        t.append(r)
    return t
T = crc_table()
def ogg_crc(b):
    c = 0
    for x in b:
        c = ((c << 8) & 0xFFFFFFFF) ^ T[((c >> 24) ^ x) & 0xFF]
    return c

def patch_head(src, dst, family, extra=b''):
    d = bytearray(open(src, 'rb').read())
    assert d[:4] == b'OggS'
    nseg = d[26]
    seg = d[27:27 + nseg]
    plen = sum(seg)
    start = 27 + nseg
    head = bytes(d[start:start + plen])
    assert head[:8] == b'OpusHead'
    ch = head[9]
    base = head[:18]
    new = bytearray(base)
    new += bytes([family])
    if family == 2:
        new += head[19:]            # stream count, coupled count, mapping table kept from family 255
    else:
        new += extra
    # one lacing segment per 255 bytes
    lac = []
    n = len(new)
    while n >= 255:
        lac.append(255); n -= 255
    lac.append(n)
    page = bytearray(d[:26]) + bytes([len(lac)]) + bytes(lac) + new
    page[22:26] = b'\0\0\0\0'
    page[22:26] = struct.pack('<I', ogg_crc(bytes(page)))
    rest = d[start + plen:]
    open(dst, 'wb').write(bytes(page) + bytes(rest))

if subprocess.run(['which', 'ffmpeg'], capture_output=True).returncode == 0:
    for n in (4, 16):
        src = f'out/{n}ch_f32_tag3.wav'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-c:a', 'libopus', '-mapping_family', '255', '-b:a', f'{n * 24}k', f'out/{n}ch_opus_family255.opus'], check=True)
        patch_head(f'out/{n}ch_opus_family255.opus', f'out/{n}ch_opus_family2.opus', 2)
        # also try mapping family 2 straight from ffmpeg (expected to be refused)
        r = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-c:a', 'libopus', '-mapping_family', '2', f'out/{n}ch_opus_ffmpeg_family2.opus'], capture_output=True)
        print(f'ffmpeg -mapping_family 2 with {n} ch: exit {r.returncode} {r.stderr.decode().strip()[:160]}')
    # stereo Opus as a control that the Ogg/Opus path is recognised at all
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-c:a', 'libopus', 'out/stereo_control.opus'], check=True)
else:
    print('no ffmpeg: Opus files not generated')
print(sorted(os.listdir('out')))
