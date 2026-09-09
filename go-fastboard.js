(function(root,factory){
  const core=typeof module!=="undefined"&&module.exports?require("./go-core.js"):root.NcGoCore;
  const api=factory(core);
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  root.NcGoFastBoard=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(C){
  "use strict";

  const EMPTY=0,PASS=-1;

  // Flat adjacency tables. `go-core` keeps arrays of arrays, which are fine for the tree but cost a
  // pointer chase per neighbour in the playout inner loop; here neighbours live in one Int32Array.
  const FLAT=new Map();
  function flat(size){
    let t=FLAT.get(size);
    if(t)return t;
    const{neighbors,diagonals}=C.tables(size),points=size*size;
    const nbStart=new Int32Array(points+1),dgStart=new Int32Array(points+1);
    let nc=0,dc=0;
    for(let p=0;p<points;p++){nbStart[p]=nc;nc+=neighbors[p].length;dgStart[p]=dc;dc+=diagonals[p].length}
    nbStart[points]=nc;dgStart[points]=dc;
    const nb=new Int32Array(nc),dg=new Int32Array(dc);
    nc=0;dc=0;
    for(let p=0;p<points;p++){
      for(const q of neighbors[p])nb[nc++]=q;
      for(const q of diagonals[p])dg[dc++]=q;
    }
    // The eight-neighbourhood as one run per point, so "play near the last move" needs no allocation.
    const a8Start=new Int32Array(points+1),a8=new Int32Array(nc+dc);
    let ac=0;
    for(let p=0;p<points;p++){
      a8Start[p]=ac;
      for(const q of neighbors[p])a8[ac++]=q;
      for(const q of diagonals[p])a8[ac++]=q;
    }
    a8Start[points]=ac;
    t={nb,nbStart,dg,dgStart,a8,a8Start,points,size};
    FLAT.set(size,t);
    return t;
  }

  // A chain is a union-find set carrying the *pseudo-liberty* multiset of its stones: one entry per
  // (stone, adjacent empty point) pair. Keeping the count n, the sum s and the sum of squares q of that
  // multiset makes both questions the playout actually asks O(1):
  //   captured        <=>  n === 0
  //   exactly one liberty  <=>  s*s === n*q   (Cauchy-Schwarz equality: every entry is the same point)
  // and when a chain is in atari that single liberty is s/n. Exact, despite the multiplicities.
  function create(size){
    const points=size*size,t=flat(size);
    return{size,points,t,
      color:new Int8Array(points),
      parent:new Int32Array(points),
      next:new Int32Array(points),     // circular list of a chain's stones, for capture
      csize:new Int32Array(points),
      ln:new Int32Array(points),ls:new Int32Array(points),lq:new Int32Array(points),
      empties:new Int32Array(points),emptyAt:new Int32Array(points),nEmpty:0,
      ko:PASS,captured:[0,0,0],
      mark:new Int32Array(points),gen:0,
      stack:new Int32Array(points),
      roots:new Int32Array(4),mult:new Int32Array(4)};
  }

  function find(fb,x){
    const parent=fb.parent;
    let r=x;
    while(parent[r]!==r)r=parent[r];
    while(parent[x]!==r){const n=parent[x];parent[x]=r;x=n}
    return r;
  }

  // Rebuild from a `go-core` board. Every stone starts as its own chain holding its own adjacent
  // empties, then adjacent same-colour stones are unioned — which is precisely the pseudo-liberty
  // multiset of the merged chain, so no liberty recount is needed.
  function load(fb,board,ko=PASS){
    const{nb,nbStart}=fb.t,points=fb.points;
    fb.nEmpty=0;fb.ko=ko;fb.captured[1]=0;fb.captured[2]=0;
    for(let p=0;p<points;p++){
      const c=board[p];
      fb.color[p]=c;fb.parent[p]=p;fb.next[p]=p;fb.csize[p]=1;
      fb.ln[p]=0;fb.ls[p]=0;fb.lq[p]=0;
      if(c===EMPTY){fb.emptyAt[p]=fb.nEmpty;fb.empties[fb.nEmpty++]=p;continue}
      for(let i=nbStart[p],e=nbStart[p+1];i<e;i++){
        const q=nb[i];
        if(board[q]===EMPTY){fb.ln[p]++;fb.ls[p]+=q;fb.lq[p]+=q*q}
      }
    }
    for(let p=0;p<points;p++){
      const c=fb.color[p];
      if(c===EMPTY)continue;
      for(let i=nbStart[p],e=nbStart[p+1];i<e;i++){
        const q=nb[i];
        if(fb.color[q]!==c||q<p)continue;
        const a=find(fb,p),b=find(fb,q);
        if(a!==b)union(fb,a,b);
      }
    }
    return fb;
  }

  function union(fb,a,b){
    // Attach the smaller chain to the larger, then splice the two circular stone lists together.
    let big=a,small=b;
    if(fb.csize[big]<fb.csize[small]){big=b;small=a}
    fb.parent[small]=big;
    fb.csize[big]+=fb.csize[small];
    fb.ln[big]+=fb.ln[small];fb.ls[big]+=fb.ls[small];fb.lq[big]+=fb.lq[small];
    const t=fb.next[big];fb.next[big]=fb.next[small];fb.next[small]=t;
    return big;
  }

  function removeEmpty(fb,p){
    const at=fb.emptyAt[p],last=fb.empties[--fb.nEmpty];
    fb.empties[at]=last;fb.emptyAt[last]=at;
  }
  function addEmpty(fb,p){fb.emptyAt[p]=fb.nEmpty;fb.empties[fb.nEmpty++]=p}

  function capture(fb,r){
    const{nb,nbStart}=fb.t;
    let n=0,p=r;
    do{
      const stone=p;p=fb.next[p];
      fb.color[stone]=EMPTY;addEmpty(fb,stone);n++;
      for(let i=nbStart[stone],e=nbStart[stone+1];i<e;i++){
        const q=nb[i];
        if(fb.color[q]===EMPTY)continue;
        // One liberty per adjacent surviving stone, which is the correct pseudo-liberty multiplicity.
        const rr=find(fb,q);
        fb.ln[rr]++;fb.ls[rr]+=stone;fb.lq[rr]+=stone*stone;
      }
    }while(p!==r);
    return n;
  }

  // Classify a placement without mutating anything. -1 illegal (suicide or occupied), 0 legal but a
  // plain self-atari, 1 playable. The self-atari verdict is exact: the merged chain's pseudo-liberty
  // triple is assembled arithmetically from the neighbouring chains.
  function classify(fb,p,color){
    if(fb.color[p]!==EMPTY)return-1;
    const{nb,nbStart}=fb.t,roots=fb.roots,mult=fb.mult;
    let n=0,s=0,q=0,nr=0,captures=false,hasLiberty=false;
    for(let i=nbStart[p],e=nbStart[p+1];i<e;i++){
      const v=nb[i],c=fb.color[v];
      if(c===EMPTY){n++;s+=v;q+=v*v;hasLiberty=true;continue}
      const r=find(fb,v);
      let k=-1;
      for(let j=0;j<nr;j++)if(roots[j]===r){k=j;break}
      if(k<0){roots[nr]=r;mult[nr]=1;nr++}else mult[k]++;
    }
    for(let j=0;j<nr;j++){
      const r=roots[j],m=mult[j],remaining=fb.ln[r]-m;
      if(fb.color[r]===color){
        // Drop p from this chain's multiset — it appears once per stone of the chain touching p.
        n+=remaining;s+=fb.ls[r]-m*p;q+=fb.lq[r]-m*p*p;
        if(remaining>0)hasLiberty=true;
      }else if(remaining===0)captures=true;
    }
    if(!hasLiberty&&!captures)return-1;
    if(captures)return 1;
    return n>0&&s*s===n*q?0:1;
  }

  // The placement is assumed to have been classified as legal. Returns the ko point, or PASS.
  function play(fb,p,color){
    const{nb,nbStart}=fb.t,enemy=3-color;
    fb.color[p]=color;removeEmpty(fb,p);
    fb.parent[p]=p;fb.next[p]=p;fb.csize[p]=1;fb.ln[p]=0;fb.ls[p]=0;fb.lq[p]=0;
    const start=nbStart[p],end=nbStart[p+1];
    for(let i=start;i<end;i++){
      const v=nb[i];
      if(fb.color[v]===EMPTY){fb.ln[p]++;fb.ls[p]+=v;fb.lq[p]+=v*v}
    }
    for(let i=start;i<end;i++){
      const v=nb[i],c=fb.color[v];
      if(c===EMPTY)continue;
      const r=find(fb,v);
      fb.ln[r]--;fb.ls[r]-=p;fb.lq[r]-=p*p;
      if(c===color){const mine=find(fb,p);if(r!==mine)union(fb,r,mine)}
    }
    let taken=0,lastTaken=PASS;
    for(let i=start;i<end;i++){
      const v=nb[i];
      if(fb.color[v]!==enemy)continue;
      const r=find(fb,v);
      if(fb.ln[r]!==0)continue;
      lastTaken=r;taken+=capture(fb,r);
    }
    fb.captured[color]+=taken;
    if(taken!==1)return PASS;
    const mine=find(fb,p);
    // A one-stone capture that leaves the capturing chain in atari is the ko shape.
    return fb.csize[mine]===1&&fb.ln[mine]===1?lastTaken:PASS;
  }

  function isSimpleEye(fb,p,color){
    const{nb,nbStart,dg,dgStart}=fb.t;
    for(let i=nbStart[p],e=nbStart[p+1];i<e;i++)if(fb.color[nb[i]]!==color)return false;
    const enemy=3-color,ds=dgStart[p],de=dgStart[p+1];
    let hostile=0;
    for(let i=ds;i<de;i++)if(fb.color[dg[i]]===enemy)hostile++;
    return de-ds<4?hostile===0:hostile<=1;
  }

  // If the chain at `p` is in atari, the point that would rescue or capture it. Otherwise PASS.
  function ataryLiberty(fb,p){
    const r=find(fb,p),n=fb.ln[r];
    if(n<=0)return PASS;
    const s=fb.ls[r];
    return s*s===n*fb.lq[r]?s/n:PASS;
  }
  function libertiesExact(fb,p){
    const{nb,nbStart}=fb.t,r=find(fb,p);
    if(fb.ln[r]<=0)return 0;
    const s=++fb.gen,mark=fb.mark;
    let count=0,stone=r;
    do{
      for(let i=nbStart[stone],e=nbStart[stone+1];i<e;i++){
        const q=nb[i];
        if(fb.color[q]===EMPTY&&mark[q]!==s){mark[q]=s;count++}
      }
      stone=fb.next[stone];
    }while(stone!==r);
    return count;
  }

  function score(fb,komi){
    const{nb,nbStart}=fb.t,color=fb.color,points=fb.points;
    const s=++fb.gen,mark=fb.mark,stack=fb.stack;
    let black=0,white=0;
    for(let p=0;p<points;p++){
      const c=color[p];
      if(c===1){black++;continue}
      if(c===2){white++;continue}
      if(mark[p]===s)continue;
      let top=0,region=0,reachBlack=false,reachWhite=false;
      stack[top++]=p;mark[p]=s;
      while(top){
        const v=stack[--top];region++;
        for(let i=nbStart[v],e=nbStart[v+1];i<e;i++){
          const q=nb[i],qc=color[q];
          if(qc===EMPTY){if(mark[q]!==s){mark[q]=s;stack[top++]=q}}
          else if(qc===1)reachBlack=true;else reachWhite=true;
        }
      }
      if(reachBlack&&!reachWhite)black+=region;
      else if(reachWhite&&!reachBlack)white+=region;
    }
    const margin=black-white-komi;
    return{black,white,komi,margin,winner:margin>0?1:2};
  }

  // Adds this board's area ownership into `acc`: +1 per point Black holds, -1 per point White holds,
  // nothing for a neutral point. Summed over many playouts this is the statistic that says which stones
  // are actually dead — the one thing Tromp-Taylor scoring on a single position cannot tell you.
  function accumulateOwnership(fb,acc){
    const{nb,nbStart}=fb.t,color=fb.color,points=fb.points;
    const s=++fb.gen,mark=fb.mark,stack=fb.stack;
    for(let p=0;p<points;p++){
      const c=color[p];
      if(c===1){acc[p]+=1;continue}
      if(c===2){acc[p]-=1;continue}
      if(mark[p]===s)continue;
      let top=0,count=0,reachBlack=false,reachWhite=false;
      const region=[];
      stack[top++]=p;mark[p]=s;
      while(top){
        const v=stack[--top];region.push(v);count++;
        for(let i=nbStart[v],e=nbStart[v+1];i<e;i++){
          const q=nb[i],qc=color[q];
          if(qc===EMPTY){if(mark[q]!==s){mark[q]=s;stack[top++]=q}}
          else if(qc===1)reachBlack=true;else reachWhite=true;
        }
      }
      const owner=reachBlack&&!reachWhite?1:reachWhite&&!reachBlack?-1:0;
      if(owner)for(const v of region)acc[v]+=owner;
    }
  }

  return{create,load,find,classify,play,capture,isSimpleEye,ataryLiberty,libertiesExact,score,
    accumulateOwnership,flat,EMPTY,PASS};
});
