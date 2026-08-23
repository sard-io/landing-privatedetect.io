import pymupdf as fitz, sys
sys.stdout.reconfigure(encoding="utf-8")
PDFDOC={0x2D8:0x18,0x2C7:0x19,0x2C6:0x1A,0x2D9:0x1B,0x2DD:0x1C,0x2DB:0x1D,0x2DA:0x1E,0x2DC:0x1F}
def dec(t):
    out=[]
    for ch in t:
        if ch in "\n\r\t ": out.append(ch); continue
        if ch=="\u00bd": out.append("\u20bd"); continue
        o=PDFDOC.get(ord(ch),ord(ch)); n=o+0xB0
        out.append(bytes([n]).decode("cp1251") if 0xC0<=n<=0xFF else ch)
    return "".join(out)
d=fitz.open(r"C:\Users\legov\Downloads\01_merged-2.pdf")
for i in range(d.page_count):
    print(f"===== СЛАЙД {i+1:02d} =====")
    rows=[]
    for b in d[i].get_text("dict")["blocks"]:
        for l in b.get("lines",[]):
            for s in l["spans"]:
                txt=dec(s["text"]).strip()
                if txt: rows.append((round(s["size"],1), round(s["bbox"][1]), txt))
    seen=set()
    for size,y,txt in sorted(rows, key=lambda r:(-r[0], r[1])):
        k=(size,txt[:28])
        if k in seen: continue
        seen.add(k)
        print(f"  {size:>6}  {txt[:58]!r}")
