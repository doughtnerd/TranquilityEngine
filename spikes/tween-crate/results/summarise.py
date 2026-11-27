import re,sys,glob,os
d=sys.argv[1]  # results/all or results/tweens
def conv(v,u): return float(v)*{'ns':1e-3,'µs':1,'ms':1e3}[u]
res={}
for f in sorted(glob.glob(d+'/*-[0-9].txt')):
    tag,run=os.path.basename(f)[:-4].split('-')
    name=None
    for line in open(f):
        s=line.strip()
        m=re.match(r'^([a-z_0-9]+/[a-z_0-9/]+)\s*(time:.*)?$',s)
        if m and not s.startswith('time'):
            name=m.group(1)
            if m.group(2): s=m.group(2)
        m=re.search(r'time:\s+\[\S+ \S+ (\S+) (\S+) \S+ \S+\]',s)
        if m and name:
            res.setdefault(name,{}).setdefault(tag,[]).append(conv(*m.groups())); name=None
print('| Bench | base runs (µs) | after runs (µs) | base median | after median | Δ |')
print('|---|---|---|---:|---:|---:|')
for n,v in res.items():
    b=sorted(v.get('base',[]));a=sorted(v.get('after',[]))
    if not b or not a: continue
    mb=b[len(b)//2]; ma=a[len(a)//2]
    print(f"| {n} | {' / '.join(f'{x:.1f}' for x in v['base'])} | {' / '.join(f'{x:.1f}' for x in v['after'])} | {mb:.1f} | {ma:.1f} | {100*(ma-mb)/mb:+.1f}% |")
