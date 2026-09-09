(function(root,factory){
  const core=typeof module!=="undefined"&&module.exports?require("./go-core.js"):root.NcGoCore;
  const api=factory(core);
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  root.NcGoPatterns=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(C){
  "use strict";

  const{EMPTY,other,tables,collectGroup,placeStone}=C;
  const SCRATCH=new Map();
  function probeBoard(size){let b=SCRATCH.get(size);if(!b){b=new Int8Array(size*size);SCRATCH.set(size,b)}return b}

  // What actually happens if this stone lands: what it takes, and how much air it is left with.
  function probe(board,size,neighbors,point,color){
    const scratch=probeBoard(size);scratch.set(board);
    const captured=placeStone(scratch,neighbors,point,color);
    const group=collectGroup(scratch,neighbors,point,2);
    return{captured:captured.length,liberties:group.liberties,groupSize:group.stones.length};
  }

  // Hand-authored Go features. No training: these are the shapes a human is taught first.
  function features(state,point,color,lastMove){
    const size=state.size,board=state.board,{neighbors}=tables(size),enemy=other(color);
    const result=probe(board,size,neighbors,point,color);
    let contact=0,friendly=0,rescued=0,threatened=0;
    for(const q of neighbors[point]){
      if(board[q]===enemy){
        contact++;
        const group=collectGroup(board,neighbors,q);
        if(group.liberties<=2)threatened=Math.max(threatened,group.stones.length);
      }else if(board[q]===color){
        friendly++;
        const group=collectGroup(board,neighbors,q);
        if(group.liberties===1)rescued=Math.max(rescued,group.stones.length);
      }
    }
    const r=Math.floor(point/size),c=point%size;
    const line=Math.min(r,c,size-1-r,size-1-c);
    let distance=Infinity;
    if(lastMove!==undefined&&lastMove!==null&&lastMove>=0){
      const lr=Math.floor(lastMove/size),lc=lastMove%size;
      distance=Math.max(Math.abs(r-lr),Math.abs(c-lc));
    }
    return{capture:result.captured,liberties:result.liberties,selfAtari:result.liberties===1&&result.captured===0,
      groupSize:result.groupSize,rescue:rescued,threaten:threatened,contact,friendly,line,distance};
  }

  // Scores are log-odds-ish and get softmaxed by the caller, so only their differences matter.
  const WEIGHTS={
    capture:2.4,rescue:1.9,threaten:.9,contact:.45,selfAtari:-4.5,liberty:.28,
    line:[-1.5,.25,.65,.45,.3],near:[.0,1.15,.85,.5,.25,.1]
  };

  function score(f){
    let value=0;
    if(f.capture)value+=WEIGHTS.capture*Math.log1p(f.capture);
    if(f.rescue)value+=WEIGHTS.rescue*Math.log1p(f.rescue);
    if(f.threaten)value+=WEIGHTS.threaten*Math.log1p(f.threaten);
    if(f.selfAtari)value+=WEIGHTS.selfAtari;
    value+=WEIGHTS.contact*Math.min(f.contact,2);
    value+=WEIGHTS.liberty*Math.min(f.liberties,4);
    value+=WEIGHTS.line[Math.min(f.line,WEIGHTS.line.length-1)];
    if(Number.isFinite(f.distance))value+=WEIGHTS.near[Math.min(f.distance,WEIGHTS.near.length-1)];
    return value;
  }

  function softmax(scores,temperature=1){
    const max=Math.max(...scores),exp=scores.map(s=>Math.exp((s-max)/temperature));
    const total=exp.reduce((a,b)=>a+b,0)||1;
    return exp.map(e=>e/total);
  }

  return{features,score,softmax,probe,WEIGHTS};
});
