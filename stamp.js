// stamp_engine_v_final_1280.js
// - finalW: 1280
// - leftW: 560 (yazı/logo bölümü)
// - rightW: 720 (barcode bölümü)
// - increased barcode stroke thickness (moduleW >= 2)
// - reduced quiet zones (quietX = 6)

const fs = require("fs");
const zlib = require("zlib");

const TURKISH_LOCALE = "tr-TR";

/* ---------- helpers ---------- */
function normalizeUpperTR(value) {
  if (typeof value !== "string") return "";
  const n = value.normalize("NFC");
  try { return n.toLocaleUpperCase(TURKISH_LOCALE).trim(); }
  catch { return n.toUpperCase().trim(); }
}
function u16(buf, off) { return (buf[off] << 8) | buf[off+1]; }
function i16(buf, off) { const v=u16(buf,off); return (v&0x8000)? v-0x10000 : v; }
function u32(buf, off) { return (buf[off]*0x1000000)+((buf[off+1]<<16)|(buf[off+2]<<8)|buf[off+3]); }

/* ---------- TTF parsing (same robust parser) ---------- */
function parseTTF(ttf){
  const numTables=u16(ttf,4);
  let off=12;
  const tables={};
  for(let i=0;i<numTables;i++){
    const tag=ttf.slice(off,off+4).toString("ascii");
    const toff=u32(ttf,off+8);
    const tlen=u32(ttf,off+12);
    tables[tag]={offset:toff,length:tlen};
    off+=16;
  }
  const headOff=tables['head'].offset;
  const unitsPerEm=u16(ttf,headOff+18);
  const indexToLocFormat=i16(ttf,headOff+50);

  const hheaOff=tables['hhea'].offset;
  const numberOfHMetrics=u16(ttf,hheaOff+34);

  const maxpOff=tables['maxp'].offset;

  const hmtxOff=tables['hmtx'].offset;
  function getHMetric(glyphIndex){
    const mc=numberOfHMetrics;
    if(glyphIndex<mc){
      const aw=u16(ttf,hmtxOff+glyphIndex*4);
      const lsb=i16(ttf,hmtxOff+glyphIndex*4+2);
      return {advanceWidth:aw, lsb};
    } else {
      const base=hmtxOff+(mc-1)*4;
      const aw=u16(ttf,base);
      const lsb=i16(ttf,hmtxOff+mc*4+(glyphIndex-mc)*2);
      return {advanceWidth:aw, lsb};
    }
  }

  const cmapOff=tables['cmap'].offset;
  const cmapNumTable=u16(ttf,cmapOff+2);

  function findFormat4Offset(){
    function scan(fn){
      for(let i=0;i<cmapNumTable;i++){
        const pid=u16(ttf,cmapOff+4+i*8);
        const eid=u16(ttf,cmapOff+4+i*8+2);
        const subOffRel=u32(ttf,cmapOff+4+i*8+4);
        const tableStart=cmapOff+subOffRel;
        const fmt=u16(ttf,tableStart);
        if(fmt===4 && fn(pid,eid)) return tableStart;
      }
      return null;
    }
    return scan((p,e)=>p===3&&(e===1||e===10)) ?? scan((p,_e)=>p===0);
  }

  const cmapFormat4Off=findFormat4Offset();
  if(cmapFormat4Off==null) throw new Error("cmap format4 yok.");

  function glyphIndexForCodePoint(code){
    const segCountX2=u16(ttf,cmapFormat4Off+6);
    const segCount=segCountX2/2;
    const endCountOff=cmapFormat4Off+14;
    const startCountOff=endCountOff+segCount*2+2;
    const idDeltaOff=startCountOff+segCount*2;
    const idRangeOffOff=idDeltaOff+segCount*2;

    for(let s=0;s<segCount;s++){
      const endCode=u16(ttf,endCountOff+s*2);
      const startCode=u16(ttf,startCountOff+s*2);
      if(code>=startCode && code<=endCode){
        const idDelta=i16(ttf,idDeltaOff+s*2);
        const idRangeOff=u16(ttf,idRangeOffOff+s*2);
        if(idRangeOff===0) return (code+idDelta)&0xFFFF;
        const roff=idRangeOffOff + s*2 + idRangeOff + (code-startCode)*2;
        return u16(ttf,roff) || 0;
      }
    }
    return 0;
  }

  const locaOff=tables['loca'].offset;
  const glyfOff=tables['glyf'].offset;
  function glyphOffsetAndLength(glyphIndex){
    if(indexToLocFormat===0){
      const off1=u16(ttf,locaOff+glyphIndex*2)*2;
      const off2=u16(ttf,locaOff+(glyphIndex+1)*2)*2;
      return {off:glyfOff+off1, len:off2-off1};
    } else {
      const off1=u32(ttf,locaOff+glyphIndex*4);
      const off2=u32(ttf,locaOff+(glyphIndex+1)*4);
      return {off:glyfOff+off1, len:off2-off1};
    }
  }

  function getGlyph(glyphIndex){
    const {off,len} = glyphOffsetAndLength(glyphIndex);
    if(len===0) return null;
    const numberOfContours=i16(ttf,off+0);
    const xMin=i16(ttf,off+2), yMin=i16(ttf,off+4);
    const xMax=i16(ttf,off+6), yMax=i16(ttf,off+8);

    if(numberOfContours>=0){
      let p=off+10;
      const endPts=[];
      for(let c=0;c<numberOfContours;c++){ endPts.push(u16(ttf,p)); p+=2; }
      const instrLen = u16(ttf,p); p+=2;
      p+=instrLen;
      const totalPoints = endPts[endPts.length-1]+1;
      const flagsArr = new Array(totalPoints);
      for(let i=0;i<totalPoints;){
        const f=ttf[p++]; flagsArr[i++]=f;
        if(f&0x08){ const rep=ttf[p++]; for(let r=0;r<rep;r++) flagsArr[i++]=f; }
      }
      const xCoords=new Array(totalPoints); let xCur=0;
      for(let i=0;i<totalPoints;i++){
        const f=flagsArr[i];
        if(f&0x02){ const dx=ttf[p++]; xCur+=(f&0x10)?dx:-dx; }
        else { if(!(f&0x10)){ xCur+=i16(ttf,p); p+=2; } }
        xCoords[i]=xCur;
      }
      const yCoords=new Array(totalPoints); let yCur=0;
      for(let i=0;i<totalPoints;i++){
        const f=flagsArr[i];
        if(f&0x04){ const dy=ttf[p++]; yCur+=(f&0x20)?dy:-dy; }
        else { if(!(f&0x20)){ yCur+=i16(ttf,p); p+=2; } }
        yCoords[i]=yCur;
      }
      const contours=[]; let startPt=0;
      for(let ci=0;ci<numberOfContours;ci++){
        const endPt=endPts[ci];
        const arr=[];
        for(let pi=startPt;pi<=endPt;pi++){
          arr.push({x:xCoords[pi], y:yCoords[pi], onCurve: !!(flagsArr[pi]&1)});
        }
        startPt=endPt+1;
        contours.push(arr);
      }
      return { compound:false, bbox:{xMin,yMin,xMax,yMax}, contours };
    }

    // compound
    let p2=off+10; const components=[];
    const ARG_WORDS=0x0001, ARGS_ARE_XY=0x0002, HAS_SCALE=0x0008, HAS_XY_SCALE=0x0040, HAS_TRANSFORM=0x0080;
    while(true){
      if(p2+4>off+len) break;
      const flags=u16(ttf,p2); p2+=2;
      const compGlyphIndex=u16(ttf,p2); p2+=2;
      let arg1,arg2;
      if(flags & ARG_WORDS){ arg1=i16(ttf,p2); p2+=2; arg2=i16(ttf,p2); p2+=2; }
      else { arg1=ttf[p2++]; if(arg1&0x80) arg1-=0x100; arg2=ttf[p2++]; if(arg2&0x80) arg2-=0x100; }
      let m00=1,m01=0,m10=0,m11=1, dx=0, dy=0;
      if(flags & ARGS_ARE_XY){ dx=arg1; dy=arg2; }
      if(flags & HAS_SCALE){ const sc=i16(ttf,p2)/16384.0; p2+=2; m00=sc; m11=sc; }
      else if(flags & HAS_XY_SCALE){ const sx=i16(ttf,p2)/16384.0; p2+=2; const sy=i16(ttf,p2)/16384.0; p2+=2; m00=sx; m11=sy; }
      else if(flags & HAS_TRANSFORM){ m00=i16(ttf,p2)/16384.0; p2+=2; m01=i16(ttf,p2)/16384.0; p2+=2; m10=i16(ttf,p2)/16384.0; p2+=2; m11=i16(ttf,p2)/16384.0; p2+=2; }
      components.push({glyphIndex:compGlyphIndex, dx, dy, m00, m01, m10, m11});
      if(!(flags & 0x20)) break;
    }
    return { compound:true, bbox:{xMin,yMin,xMax,yMax}, components };
  }

  return { unitsPerEm, glyphIndexForCodePoint, getGlyph, getHMetric };
}

/* ---------- geometry helpers ---------- */
function approxQuad(p0,p1,p2,steps=8){
  const out=[];
  for(let i=0;i<=steps;i++){
    const t=i/steps, mt=1-t;
    out.push({ x: mt*mt*p0.x + 2*mt*t*p1.x + t*t*p2.x, y: mt*mt*p0.y + 2*mt*t*p1.y + t*t*p2.y });
  }
  return out;
}
function contourToPolygon(contour, stepsPerCurve=8){
  const n=contour.length;
  function P(i){ return contour[(i+n)%n]; }
  const poly=[];
  for(let i=0;i<n;i++){
    const p0=P(i), p1=P(i+1);
    if(p0.onCurve && p1.onCurve){ poly.push({x:p0.x,y:p0.y}); }
    else if(p0.onCurve && !p1.onCurve){
      const p2=P(i+2);
      if(p2.onCurve){
        const seg=approxQuad(p0,p1,p2,stepsPerCurve);
        for(let k=0;k<seg.length-1;k++) poly.push(seg[k]);
      } else {
        const mid={x:(p1.x+p2.x)/2, y:(p1.y+p2.y)/2};
        const seg=approxQuad(p0,p1,mid,stepsPerCurve);
        for(let k=0;k<seg.length-1;k++) poly.push(seg[k]);
      }
    } else if(!p0.onCurve && p1.onCurve){
      // covered by previous
    } else {
      const mid={x:(p0.x+p1.x)/2, y:(p0.y+p1.y)/2};
      poly.push(mid);
    }
  }
  return poly;
}
function windingContains(px,py,polyList){
  let wn=0;
  for(const poly of polyList){
    const pts=poly.pts;
    for(let i=0,j=pts.length-1;i<pts.length;j=i++){
      const xi=pts[i].x, yi=pts[i].y, xj=pts[j].x, yj=pts[j].y;
      const inter = ((yi<=py && yj>py) || (yi>py && yj<=py));
      if(inter){
        const vt=(py-yi)/((yj-yi)||1e-9);
        const xCross = xi + vt*(xj-xi);
        if(xCross>px){ if(yj>yi) wn+=1; else wn-=1; }
      }
    }
  }
  return wn!==0;
}

/* ---------- raster glyphs ---------- */
function rasterGlyphRecursive(pixels, W, fontData, glyphObj, drawX, baselineY, scale, color){
  if(!glyphObj) return;
  if(!glyphObj.compound){
    const polys=[];
    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
    for(const contour of glyphObj.contours){
      const polyPts=contourToPolygon(contour,8);
      if(polyPts.length<3) continue;
      for(const pt of polyPts){ if(pt.x<minX) minX=pt.x; if(pt.x>maxX) maxX=pt.x; if(pt.y<minY) minY=pt.y; if(pt.y>maxY) maxY=pt.y; }
      polys.push({pts:polyPts});
    }
    if(minX===Infinity) return;
    const x0=Math.floor(drawX + minX*scale);
    const x1=Math.ceil (drawX + maxX*scale);
    const y0=Math.floor(baselineY - maxY*scale);
    const y1=Math.ceil (baselineY - minY*scale);

    for(let py=y0; py<y1; py++){
      if(py<0) continue;
      for(let px=x0; px<x1; px++){
        if(px<0 || px>=W) continue;
        const fx=(px-drawX)/scale;
        const fy=(baselineY-py)/scale;
        if(windingContains(fx,fy,polys)){
          const idx=(py*W+px)*4;
          pixels[idx]=color[0]; pixels[idx+1]=color[1]; pixels[idx+2]=color[2]; pixels[idx+3]=color[3];
        }
      }
    }
    return;
  }
  for(const comp of glyphObj.components){
    const subGlyph=fontData.getGlyph(comp.glyphIndex);
    const subScaleX = scale * comp.m00;
    const subScaleY = scale * comp.m11;
    const mergedScale = (subScaleX + subScaleY) * 0.5;
    rasterGlyphRecursive(pixels, W, fontData, subGlyph, drawX + comp.dx*scale, baselineY - comp.dy*scale, mergedScale, color);
  }
}

/* ---------- text draw/measure ---------- */
function drawTextTTF(pixels,W,text,startX,baselineY,fontData,fontSizePx,color){
  const scale = fontSizePx / fontData.unitsPerEm;
  let penX = startX;
  for(const ch of text){
    if(ch === " "){ penX += fontSizePx*0.4; continue; }
    const code = ch.codePointAt(0);
    const gIndex = fontData.glyphIndexForCodePoint(code);
    if(!gIndex){ penX += fontSizePx*0.4; continue; }
    const glyph = fontData.getGlyph(gIndex);
    const {advanceWidth, lsb} = fontData.getHMetric(gIndex);
    if(glyph){
      rasterGlyphRecursive(pixels, W, fontData, glyph, penX + lsb*scale, baselineY, scale, color);
    }
    penX += advanceWidth*scale;
  }
  return penX;
}
function measureTextTTF(text,fontData,fontSizePx){
  const scale = fontSizePx / fontData.unitsPerEm;
  let pen = 0;
  for(const ch of text){
    if(ch===" "){ pen+=fontSizePx*0.4; continue; }
    const gi = fontData.glyphIndexForCodePoint(ch.codePointAt(0));
    if(!gi){ pen+=fontSizePx*0.4; continue; }
    const m = fontData.getHMetric(gi);
    pen += m.advanceWidth*scale;
  }
  return pen;
}

/* ---------- downsample ---------- */
function downsample(pix,HW,HH,width,height,SS){
  const out = Buffer.alloc(width*height*4);
  for(let ty=0; ty<height; ty++){
    for(let tx=0; tx<width; tx++){
      const sx0 = tx*SS, sy0 = ty*SS;
      let rSum=0,gSum=0,bSum=0,aSum=0,count=0;
      for(let y=sy0;y<sy0+SS;y++){
        for(let x=sx0;x<sx0+SS;x++){
          const idx=(y*HW+x)*4;
          rSum+=pix[idx]; gSum+=pix[idx+1]; bSum+=pix[idx+2]; aSum+=pix[idx+3]; count++;
        }
      }
      const i2=(ty*width+tx)*4;
      out[i2]=Math.round(rSum/count); out[i2+1]=Math.round(gSum/count); out[i2+2]=Math.round(bSum/count); out[i2+3]=Math.round(aSum/count);
    }
  }
  return out;
}

/* ---------- grain PRNG ---------- */
function makeFastSeed(){
  const baseStr = Date.now().toString() + "|" + process.hrtime().join(":");
  let h = 2166136261 >>> 0;
  for(let i=0;i<baseStr.length;i++){
    h ^= baseStr.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function makePRNG(seed){
  let s = seed >>> 0;
  return function(x,y){
    s ^= (s << 13) >>> 0;
    s ^= (s >>> 17);
    s ^= (s << 5) >>> 0;
    s = (s + ((x&0xffff) * 374761393 + (y&0xffff) * 668265263) ) >>> 0;
    return (s & 0xFF);
  };
}
function applyGrainTransparentTop(pix,W,H,prngByte){
  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      const b = prngByte(x,y);
      if (b % 20 === 0){
        const idx=(y*W+x)*4; pix[idx]=0; pix[idx+1]=0; pix[idx+2]=0; pix[idx+3]=255; continue;
      }
      if (b % 137 === 0){
        const idx=(y*W+x)*4; pix[idx]=30; pix[idx+1]=30; pix[idx+2]=30; pix[idx+3]=255;
      }
    }
  }
  const clusterSize=4;
  for(let y=0;y<H;y+=3){
    for(let x=0;x<W;x+=3){
      const b=prngByte(x,y);
      if((b%7)===0){
        for(let yy=0;yy<clusterSize;yy++){
          for(let xx=0;xx<clusterSize;xx++){
            const px=x+xx, py=y+yy;
            if(px>=W||py>=H) continue;
            const idx=(py*W+px)*4; pix[idx]=0; pix[idx+1]=0; pix[idx+2]=0; pix[idx+3]=255;
          }
        }
      }
    }
  }
}

/* ---------- PNG loader (logo) ---------- */
function paethPredictor(a,b,c){ const p=a+b-c; const pa=Math.abs(p-a), pb=Math.abs(p-b), pc=Math.abs(p-c); if(pa<=pb && pa<=pc) return a; if(pb<=pc) return b; return c; }
function unfilterScanline(filterType, scanline, prevScanline, bpp){
  const out=Buffer.from(scanline);
  const len=scanline.length;
  if(filterType===0) return out;
  if(filterType===1){ for(let i=0;i<len;i++){ const left=(i>=bpp)?out[i-bpp]:0; out[i]=(out[i]+left)&0xFF; } return out; }
  if(filterType===2){ for(let i=0;i<len;i++){ const up=prevScanline?prevScanline[i]:0; out[i]=(out[i]+up)&0xFF; } return out; }
  if(filterType===3){ for(let i=0;i<len;i++){ const left=(i>=bpp)?out[i-bpp]:0; const up=prevScanline?prevScanline[i]:0; const avg=Math.floor((left+up)/2); out[i]=(out[i]+avg)&0xFF; } return out; }
  if(filterType===4){ for(let i=0;i<len;i++){ const left=(i>=bpp)?out[i-bpp]:0; const up=prevScanline?prevScanline[i]:0; const upLeft=(i>=bpp && prevScanline)?prevScanline[i-bpp]:0; const paeth=paethPredictor(left,up,upLeft); out[i]=(out[i]+paeth)&0xFF; } return out; }
  throw new Error("Unsupported filter "+filterType);
}
function loadPngRGBA(path){
  const data=fs.readFileSync(path);
  if(!(data[0]===0x89 && data[1]===0x50 && data[2]===0x4E && data[3]===0x47)) throw new Error("PNG değil.");
  let ptr=8; let width=0,height=0,bitDepth=0,colorType=0,interlace=0; const idats=[];
  while(ptr<data.length){
    const len=u32(data,ptr); ptr+=4;
    const type=data.slice(ptr,ptr+4).toString("ascii"); ptr+=4;
    const chunkData=data.slice(ptr,ptr+len); ptr+=len;
    ptr+=4;
    if(type==="IHDR"){ width=u32(chunkData,0); height=u32(chunkData,4); bitDepth=chunkData[8]; colorType=chunkData[9]; interlace=chunkData[12]; }
    else if(type==="IDAT") idats.push(chunkData);
    else if(type==="IEND") break;
  }
  if(bitDepth!==8 || colorType!==6) throw new Error("RGBA 8-bit PNG olmalı.");
  if(interlace!==0) throw new Error("Adam7 desteklenmiyor.");
  const inflated=zlib.inflateSync(Buffer.concat(idats));
  const stride=width*4;
  const outRGBA=Buffer.alloc(width*height*4);
  let inPtr=0; let prev=null;
  for(let y=0;y<height;y++){
    const filterType=inflated[inPtr++];
    const rawScan=inflated.slice(inPtr,inPtr+stride);
    inPtr+=stride;
    const recon=unfilterScanline(filterType,rawScan,prev,4);
    recon.copy(outRGBA,y*stride,0,stride);
    prev=recon;
  }
  return { width, height, data: outRGBA };
}

/* ---------- blit ---------- */
function blitRGBA(pixels,W,srcRGBA,srcW,srcH,dstX,dstY,scale,colorMul){
  const scaledW=Math.floor(srcW*scale);
  const scaledH=Math.floor(srcH*scale);
  for(let yy=0; yy<scaledH; yy++){
    for(let xx=0; xx<scaledW; xx++){
      const srcY=Math.floor(yy/scale);
      const srcX=Math.floor(xx/scale);
      const sIdx=(srcY*srcW+srcX)*4;
      const sr=srcRGBA[sIdx], sg=srcRGBA[sIdx+1], sb=srcRGBA[sIdx+2], sa=srcRGBA[sIdx+3];
      if(sa===0) continue;
      const dx=dstX+xx, dy=dstY+yy;
      const dIdx=(dy*W+dx)*4;
      const a=sa/255, inv=1-a;
      pixels[dIdx  ]=Math.round(sr*colorMul[0]*a + pixels[dIdx  ]*inv);
      pixels[dIdx+1]=Math.round(sg*colorMul[1]*a + pixels[dIdx+1]*inv);
      pixels[dIdx+2]=Math.round(sb*colorMul[2]*a + pixels[dIdx+2]*inv);
      pixels[dIdx+3]=255;
    }
  }
}

/* ---------- Code39 map & helpers ---------- */
const CODE39_MAP={
  "0":"101001101101","1":"110100101011","2":"101100101011","3":"110110010101",
  "4":"101001101011","5":"110100110101","6":"101100110101","7":"101001011011",
  "8":"110100101101","9":"101100101101",
  "A":"110101001011","B":"101101001011","C":"110110100101","D":"101011001011",
  "E":"110101100101","F":"101101100101","G":"101010011011","H":"110101001101",
  "I":"101101001101","J":"101011001101",
  "K":"110101010011","L":"101101010011","M":"110110101001","N":"101011010011",
  "O":"110101101001","P":"101101101001","Q":"101010110011","R":"110101011001",
  "S":"101101011001","T":"101011011001",
  "U":"110010101011","V":"100110101011","W":"110011010101","X":"100101101011",
  "Y":"110010110101","Z":"100110110101",
  "-":"100101011011",".":"110010101101"," ":"100110101101",
  "$":"100100100101","/":"100100101001","+":"100101001001","%":"101001001001",
  "*":"100101101101"
};
function makeBarcodeCore(){
  return "FITFAK-" + Date.now().toString(36).toUpperCase();
}
function encodeCode39Data(core){
  const data="*"+core.toUpperCase()+"*";
  const parts=[];
  for(const ch of data){
    const patt=CODE39_MAP[ch];
    if(!patt) throw new Error("Unsupported char:"+ch);
    parts.push(patt);
  }
  return parts.join("0");
}

/* ---------- top half (grain + name) ---------- */
function layoutNameLines(personName,fontData,fontPx,maxTextWidthPx){
  const normalized=normalizeUpperTR(personName);
  const words=normalized.length>0?normalized.split(/\s+/).filter(w=>w.length>0):[];
  function W(s){ return measureTextTTF(s,fontData,fontPx); }
  if(words.length===0) return [""];
  if(words.length===1) return [words[0]];
  if(words.length===2){
    const both=words[0]+" "+words[1];
    if(W(both)<=maxTextWidthPx) return [both];
    return [words[0], words[1]];
  }
  const first=words[0], rest=words.slice(1).join(" ");
  return [first,rest];
}
function drawTopHalfSS({ pixels, Wss, HhalfSS, fontData, personName }){
  const prngByte = makePRNG(makeFastSeed());
  applyGrainTransparentTop(pixels, Wss, HhalfSS, prngByte);

  const color=[35,35,35,255];
  const lineFontPx = HhalfSS * 0.32;
  const sideMargin = Math.floor(Wss*0.06);
  const maxTextWidthPx = Wss - sideMargin*2;
  const lines = layoutNameLines(personName,fontData,lineFontPx,maxTextWidthPx);
  const n = lines.length;
  const lineGap = lineFontPx * 0.45;
  const blockH = n*lineFontPx + (n-1)*lineGap;
  const centerY = Math.floor(HhalfSS/2);
  const blockY0 = Math.floor(centerY - blockH/2);

  for(let i=0;i<n;i++){
    const ln = lines[i];
    const w = measureTextTTF(ln,fontData,lineFontPx);
    const x = Math.floor((Wss-w)/2);
    const baseline = Math.floor(blockY0 + i*(lineFontPx+lineGap) + lineFontPx);
    drawTextTTF(pixels,Wss,ln,x,baseline,fontData,lineFontPx,color);
  }
}

/* ---------- bottom half (dark band + logo + FITFAK) ---------- */
function drawBottomHalfSS({ pixels, Wss, HhalfSS, startYss, fontData, pngLogoPath }){
  const BASE_TONE = 35;
  for(let y=startYss;y<startYss+HhalfSS;y++){
    for(let x=0;x<Wss;x++){
      const idx=(y*Wss+x)*4;
      pixels[idx]=BASE_TONE; pixels[idx+1]=BASE_TONE; pixels[idx+2]=BASE_TONE; pixels[idx+3]=255;
    }
  }

  const logo = loadPngRGBA(pngLogoPath);
  const logoTargetH = Math.floor(HhalfSS * 0.6);
  const scaleLogo = logoTargetH / logo.height;
  const scaledLogoH = Math.floor(logo.height * scaleLogo);
  const leftMargin = Math.floor(Wss * 0.06);
  const logoX = leftMargin;
  const centerY = startYss + Math.floor(HhalfSS*0.5);
  const logoY = Math.floor(centerY - scaledLogoH/2);

  blitRGBA(pixels, Wss, logo.data, logo.width, logo.height, logoX, logoY, scaleLogo, [1,1,1,1]);

  // FITFAK büyük ortalı (aynı dikey merkez hattında olacak)
  const textColor=[220,220,220,255];
  const label = normalizeUpperTR("FITFAK");
  const fitfakFontPx = HhalfSS * 0.6;
  const txtW = measureTextTTF(label, fontData, fitfakFontPx);
  const txtX = Math.floor((Wss - txtW)/2);
  const baseline = Math.floor(centerY + fitfakFontPx*0.35);

  drawTextTTF(pixels, Wss, label, txtX, baseline, fontData, fitfakFontPx, textColor);
}

/* ---------- barcode render (right panel) ---------- */
function renderBarcodePanelFinal({ panelW, panelH, barcodeBits }){
  const out = Buffer.alloc(panelW * panelH * 4);
  for(let i=0;i<out.length;i+=4){ out[i]=255; out[i+1]=255; out[i+2]=255; out[i+3]=255; }

  const quietX = 6; // küçültülmüş quiet zone
  const usableW = panelW - quietX*2;

  const patternLen = barcodeBits.length;

  // module width: öncelik usableW / patternLen, ama minimum 2 px
  let moduleW = Math.floor(usableW / patternLen);
  if(moduleW < 2) moduleW = 2;

  // Eğer moduleW çok büyük olursa (paneller küçükse) limitle
  // ama genelde moduleW = 2..5 arası olacak ve çizgiler daha kalın
  const barcodeW = moduleW * patternLen;
  const startX = Math.floor((panelW - barcodeW) / 2);

  const startY = 0;
  const barHeight = panelH; // full height

  for(let i=0;i<patternLen;i++){
    if(barcodeBits[i] === "1"){
      const x0 = startX + i*moduleW;
      for(let xx=0; xx<moduleW; xx++){
        const px = x0 + xx;
        if(px<0 || px>=panelW) continue;
        for(let yy=0; yy<barHeight; yy++){
          const py = startY + yy;
          const idx = (py*panelW + px)*4;
          out[idx]=0; out[idx+1]=0; out[idx+2]=0; out[idx+3]=255;
        }
      }
    }
  }

  return out;
}

/* ---------- PNG encode helpers ---------- */
function crc32(buf){
  let c=~0;
  for(let i=0;i<buf.length;i++){
    c ^= buf[i];
    for(let k=0;k<8;k++) c = (c&1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1);
  }
  return (~c)>>>0;
}
function makeChunk(type,data){
  const tb = Buffer.from(type, "ascii");
  const lb = Buffer.alloc(4); lb.writeUInt32BE(data.length,0);
  const crcVal = crc32(Buffer.concat([tb,data]));
  const cb = Buffer.alloc(4); cb.writeUInt32BE(crcVal,0);
  return Buffer.concat([lb,tb,data,cb]);
}
function makeIHDR(w,h){
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w,0); b.writeUInt32BE(h,4);
  b[8]=8; b[9]=6; b[10]=0; b[11]=0; b[12]=0;
  return makeChunk("IHDR", b);
}
function makeIDAT(pixels,w,h){
  const raw = Buffer.alloc((w*4+1)*h);
  for(let y=0;y<h;y++){
    raw[y*(w*4+1)] = 0;
    pixels.copy(raw, y*(w*4+1)+1, y*w*4, (y+1)*w*4);
  }
  const def = zlib.deflateSync(raw);
  return makeChunk("IDAT", def);
}
function makeIEND(){ return makeChunk("IEND", Buffer.alloc(0)); }

/* ---------- main generator ---------- */
function generateStamp({
  fontPath,
  pngLogoPath,
  personName,
  outPath,
  finalW = 1280,
  finalH = 320,
  leftW = 560,
  rightW = 720,
  SS = 4
}){
  if(leftW + rightW !== finalW) throw new Error("leftW + rightW must equal finalW");

  const halfH_final = finalH / 2; // 160
  const HhalfSS = halfH_final * SS;
  const HW = leftW * SS;
  const HH_totalSS = finalH * SS;

  // supersampled buffer for left panel
  const pixSS = Buffer.alloc(HW * HH_totalSS * 4);
  for(let i=0;i<pixSS.length;i+=4){ pixSS[i]=0; pixSS[i+1]=0; pixSS[i+2]=0; pixSS[i+3]=0; }

  const fontBuf = fs.readFileSync(fontPath);
  const fontData = parseTTF(fontBuf);

  // draw top half (grain + name)
  drawTopHalfSS({ pixels: pixSS, Wss: HW, HhalfSS: HhalfSS, fontData, personName });

  // draw bottom half (dark band + logo + FITFAK)
  drawBottomHalfSS({ pixels: pixSS, Wss: HW, HhalfSS: HhalfSS, startYss: HhalfSS, fontData, pngLogoPath });

  // downsample left panel
  const leftPanelFinalRGBA = downsample(pixSS, HW, HH_totalSS, leftW, finalH, SS);

  // right panel barcode generation
  const core = makeBarcodeCore();
  const bits = encodeCode39Data(core);
  const barcodePanelRGBA = renderBarcodePanelFinal({ panelW: rightW, panelH: finalH, barcodeBits: bits });

  // final canvas
  const finalPix = Buffer.alloc(finalW * finalH * 4);

  // copy left
  for(let y=0;y<finalH;y++){
    const dstBase = (y*finalW)*4;
    const srcBase = (y*leftW)*4;
    leftPanelFinalRGBA.copy(finalPix, dstBase, srcBase, srcBase + leftW*4);
  }
  // copy right
  for(let y=0;y<finalH;y++){
    const dstBase = ((y*finalW)+leftW)*4;
    const srcBase = (y*rightW)*4;
    barcodePanelRGBA.copy(finalPix, dstBase, srcBase, srcBase + rightW*4);
  }

  const sig = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  const ihdr = makeIHDR(finalW, finalH);
  const idat = makeIDAT(finalPix, finalW, finalH);
  const iend = makeIEND();
  const pngBuf = Buffer.concat([sig, ihdr, idat, iend]);

  if (outPath) {
    fs.writeFileSync(outPath, pngBuf);
  }

  return pngBuf;
}

/* ---------- export + example run ---------- */
module.exports = { generateStamp };
