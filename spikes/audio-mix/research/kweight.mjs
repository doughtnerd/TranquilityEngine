// Derives BS.1770 K-weighting biquads for any rate from the libebur128 formulas
// (libebur128.c:251-300, fetched from jiixyj/libebur128 master). Usage: node kweight.mjs 48000 44100
for (const fs of process.argv.slice(2).map(Number)) {
  let f0=1681.974450955533,G=3.999843853973347,Q=0.7071752369554196;
  let K=Math.tan(Math.PI*f0/fs),Vh=10**(G/20),Vb=Vh**0.4996667741545416;
  const a0=1+K/Q+K*K;
  const sh={b:[(Vh+Vb*K/Q+K*K)/a0,2*(K*K-Vh)/a0,(Vh-Vb*K/Q+K*K)/a0],a:[2*(K*K-1)/a0,(1-K/Q+K*K)/a0]};
  f0=38.13547087602444;Q=0.5003270373238773;K=Math.tan(Math.PI*f0/fs);
  const hp={a:[2*(K*K-1)/(1+K/Q+K*K),(1-K/Q+K*K)/(1+K/Q+K*K)]};
  console.log(fs,'shelf',JSON.stringify(sh),'highpass(b=1,-2,1)',JSON.stringify(hp));
}
