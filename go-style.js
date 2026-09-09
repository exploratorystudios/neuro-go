(function(root,factory){
  const core=typeof module!=="undefined"&&module.exports?require("./go-core.js"):root.NcGoCore;
  const patterns=typeof module!=="undefined"&&module.exports?require("./go-patterns.js"):root.NcGoPatterns;
  const api=factory(core,patterns);
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  root.NcGoStyle=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(C,Pat){
  "use strict";

  const{EMPTY,BLACK,PASS,other}=C;

  // ---------------------------------------------------------------------------------------------
  // Symmetry
  //
  // A Go position and its seven reflections are the same position, and a corpus of 6,672 games is
  // small enough that failing to say so costs eight times the evidence. Every key in this file — the
  // 3x3 pattern and the opening book alike — is folded onto a canonical representative first.
  // ---------------------------------------------------------------------------------------------
  const TRANSFORM=[
    (r,c,s)=>[r,c],(r,c,s)=>[r,s-1-c],(r,c,s)=>[s-1-r,c],(r,c,s)=>[s-1-r,s-1-c],
    (r,c,s)=>[c,r],(r,c,s)=>[c,s-1-r],(r,c,s)=>[s-1-c,r],(r,c,s)=>[s-1-c,s-1-r]
  ];
  const MAPS=new Map();
  function maps(size){
    let table=MAPS.get(size);
    if(table)return table;
    const forward=[],inverse=[];
    for(let t=0;t<8;t++){
      const f=new Int32Array(size*size),g=new Int32Array(size*size);
      for(let r=0;r<size;r++)for(let c=0;c<size;c++){
        const[rr,cc]=TRANSFORM[t](r,c,size),from=r*size+c,to=rr*size+cc;
        f[from]=to;g[to]=from;
      }
      forward.push(f);inverse.push(g);
    }
    table={forward,inverse};MAPS.set(size,table);return table;
  }
  const mapPoint=(size,point,t)=>point===PASS?PASS:maps(size).forward[t][point];
  const unmapPoint=(size,point,t)=>point===PASS?PASS:maps(size).inverse[t][point];

  // ---------------------------------------------------------------------------------------------
  // 3x3 patterns
  //
  // Eight neighbours in row-major order, two bits each: empty, own, enemy, off-board. Colours are
  // read relative to the player to move, so one table serves both sides. The line number rides along
  // in the key because "third line" and "fourth line" are different moves with identical surroundings.
  // ---------------------------------------------------------------------------------------------
  const OFFSETS=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  // How each of the eight board symmetries permutes those eight slots.
  const SLOT=(()=>{
    const index=new Map(OFFSETS.map(([dr,dc],i)=>[`${dr},${dc}`,i]));
    return TRANSFORM.map(fn=>{
      const perm=new Int32Array(8);
      for(let i=0;i<8;i++){
        // The neighbourhood is 3x3, so the same transform applied about its centre is the map with s=3
        // on coordinates shifted into 0..2.
        const[dr,dc]=OFFSETS[i],[rr,cc]=fn(dr+1,dc+1,3);
        perm[i]=index.get(`${rr-1},${cc-1}`);
      }
      return perm;
    });
  })();
  const LINES=5;

  // The raw, un-folded code for a point: the same eight slots in fixed order, without the symmetry
  // search. This runs once per candidate per move of every playout, so the neighbourhood and the line
  // number are precomputed per board size — no division, no bounds tests, eight array reads.
  const SLOTS=new Map();
  function slotTable(size){
    let table=SLOTS.get(size);
    if(table)return table;
    const points=size*size,index=new Int32Array(points*8),line=new Int8Array(points);
    for(let r=0;r<size;r++)for(let c=0;c<size;c++){
      const p=r*size+c;
      line[p]=Math.min(Math.min(r,c),Math.min(size-1-r,size-1-c),LINES-1);
      for(let i=0;i<8;i++){
        const rr=r+OFFSETS[i][0],cc=c+OFFSETS[i][1];
        index[p*8+i]=rr<0||rr>=size||cc<0||cc>=size?-1:rr*size+cc;
      }
    }
    table={index,line};SLOTS.set(size,table);return table;
  }
  function rawKey(board,size,point,color){
    const table=SLOTS.get(size)||slotTable(size),index=table.index,base=point*8;
    let code=0;
    for(let i=0;i<8;i++){
      const q=index[base+i];
      const stone=q<0?-1:board[q];
      code=(code<<2)|(stone<0?3:stone===EMPTY?0:stone===color?1:2);
    }
    return code*LINES+table.line[point];
  }
  const RAW_KEYS=65536*LINES;

  // Fold a raw code onto its canonical representative. Used once per personality to expand the
  // sparse fitted table into a flat lookup, so nothing at play time ever searches the symmetries.
  function canonicalOf(code){
    const slots=new Uint8Array(8);
    for(let i=0;i<8;i++)slots[i]=(code>>((7-i)*2))&3;
    let best=0xffffffff;
    for(let t=0;t<8;t++){
      const perm=SLOT[t];
      let folded=0;
      for(let i=0;i<8;i++)folded=(folded<<2)|slots[perm[i]];
      if(folded<best)best=folded;
    }
    return best;
  }
  function expandPatterns(table){
    const flat=new Float32Array(RAW_KEYS);
    if(!table||!table.size)return flat;
    for(let code=0;code<65536;code++){
      const canonical=canonicalOf(code)*LINES;
      for(let line=0;line<LINES;line++){
        const value=table.get(canonical+line);
        if(value!==undefined)flat[code*LINES+line]=value;
      }
    }
    return flat;
  }

  function patternKey(board,size,point,color){
    const r=Math.floor(point/size),c=point%size,enemy=other(color);
    const slots=new Uint8Array(8);
    for(let i=0;i<8;i++){
      const rr=r+OFFSETS[i][0],cc=c+OFFSETS[i][1];
      if(rr<0||rr>=size||cc<0||cc>=size){slots[i]=3;continue}
      const stone=board[rr*size+cc];
      slots[i]=stone===EMPTY?0:stone===color?1:stone===enemy?2:0;
    }
    let best=0xffffffff;
    for(let t=0;t<8;t++){
      const perm=SLOT[t];
      let code=0;
      for(let i=0;i<8;i++)code=(code<<2)|slots[perm[i]];
      if(code<best)best=code;
    }
    const line=Math.min(r,c,size-1-r,size-1-c);
    return best*LINES+Math.min(line,LINES-1);
  }

  // The board itself, folded the same way. The chosen transform comes back with the key so a book
  // move stored in canonical space can be mapped onto the board actually in front of the engine.
  //
  // The mix has to be order-independent, because the eight transforms visit the same stones in eight
  // different orders. XOR over a Zobrist table is; anything that folds a running value is not.
  const ZOBRIST=new Map();
  function zobrist(size){
    let table=ZOBRIST.get(size);
    if(table)return table;
    const random=C.rng(0x60570000^size),points=size*size;
    table=[new Int32Array(points),new Int32Array(points)];
    for(let i=0;i<points;i++){table[0][i]=(random()*4294967296)|0;table[1][i]=(random()*4294967296)|0}
    ZOBRIST.set(size,table);return table;
  }
  function canonicalBoard(board,size,toPlay){
    const{forward}=maps(size),table=zobrist(size);
    let bestKey=0,bestTransform=0;
    for(let t=0;t<8;t++){
      const f=forward[t];
      let hash=0;
      // Colours are keyed relative to the side to move, so a mirrored colour-swapped position is the
      // same book entry and both players draw on the same evidence.
      for(let p=0;p<board.length;p++){
        const stone=board[p];
        if(stone!==EMPTY)hash=(hash^table[stone===toPlay?0:1][f[p]])|0;
      }
      if(t===0||hash<bestKey){bestKey=hash;bestTransform=t}
    }
    return{key:bestKey,transform:bestTransform};
  }

  // ---------------------------------------------------------------------------------------------
  // Personalities
  // ---------------------------------------------------------------------------------------------
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));

  // A personality is data, not code: fitted feature weights, a pattern table, an opening book and a
  // set of plan seeds for the cognitive layer. `styleWeight` is the dial between the engine's own
  // hand-authored judgement and the archetype's, and exists because imitation is not the same thing
  // as strength — see tools/style-arena.cjs for what each setting actually costs.
  function createPersonality(spec,{styleWeight=1,bookWeight=1,playoutWeight=1}={}){
    const patternTable=new Map();
    if(spec.patterns)for(const[key,value]of Object.entries(spec.patterns))patternTable.set(Number(key),value);
    const book=new Map();
    if(spec.book)for(const[key,value]of Object.entries(spec.book))book.set(Number(key),value);
    return{
      id:spec.id,name:spec.name,label:spec.label,
      table:expandPatterns(patternTable),
      weights:spec.weights||null,
      patterns:patternTable,
      book,
      plans:spec.plans||null,
      frame:spec.frame||null,
      traits:spec.traits||null,
      styleWeight,bookWeight,playoutWeight,
      stats:spec.stats||null
    };
  }

  // The additive term a personality contributes to one candidate move's prior, in the same log-odds
  // units `go-patterns` scores in. Two parts: the fitted linear model over the ordinary features, and
  // the pattern table's opinion of the shape being played into.
  function moveBonus(personality,board,size,point,color,features){
    if(!personality)return 0;
    let value=0;
    const w=personality.weights;
    if(w){
      const f=features;
      if(f.capture)value+=w.capture*Math.log1p(f.capture);
      if(f.rescue)value+=w.rescue*Math.log1p(f.rescue);
      if(f.threaten)value+=w.threaten*Math.log1p(f.threaten);
      if(f.selfAtari)value+=w.selfAtari;
      value+=w.contact*Math.min(f.contact,2);
      value+=w.friendly*Math.min(f.friendly,2);
      value+=w.liberty*Math.min(f.liberties,4);
      value+=w.line[Math.min(f.line,w.line.length-1)];
      if(Number.isFinite(f.distance))value+=w.near[Math.min(f.distance,w.near.length-1)];
    }
    if(personality.patterns.size)value+=personality.table[rawKey(board,size,point,color)];
    return value*personality.styleWeight;
  }

  // The rollout wants a multiplicative weight, not a log-odds one, and a `Math.exp` per candidate per
  // move of every playout is the single most expensive thing this feature could do. The exponential is
  // taken once here, over the whole flat table, and cached per strength.
  function playoutTable(personality,weight){
    if(!personality)return null;
    if(personality._playoutWeight===weight&&personality._playoutTable)return personality._playoutTable;
    const source=personality.table,out=new Float32Array(source.length);
    for(let i=0;i<source.length;i++)out[i]=source[i]?Math.exp(weight*source[i]):1;
    personality._playoutWeight=weight;personality._playoutTable=out;
    return out;
  }

  // Opening book: the moves this archetype's players actually chose from this exact position, with
  // their counts. Returned in the coordinate frame of the board that was asked about.
  function bookMoves(personality,state){
    if(!personality||!personality.book.size)return null;
    const{key,transform}=canonicalBoard(state.board,state.size,state.toPlay);
    const entry=personality.book.get(key);
    if(!entry)return null;
    const total=entry.reduce((sum,x)=>sum+x[1],0)||1;
    return entry.map(([point,count])=>({point:unmapPoint(state.size,point,transform),
      count,share:count/total}));
  }

  // Plan seeds: an archetype that fights starts its mind believing in attack, rather than discovering
  // it move by move. The seeds are blended toward the engine's neutral start by `styleWeight`.
  function seedPlans(personality,plans){
    if(!personality||!personality.plans)return plans;
    const out={...plans},k=clamp(personality.styleWeight,0,1);
    for(const id of Object.keys(out)){
      const target=personality.plans[id];
      if(typeof target==="number")out[id]=out[id]*(1-k)+target*k;
    }
    return out;
  }

  return{patternKey,rawKey,canonicalOf,expandPatterns,canonicalBoard,mapPoint,unmapPoint,maps,
    slotTable,createPersonality,moveBonus,bookMoves,playoutTable,seedPlans,OFFSETS,LINES,RAW_KEYS};
});
