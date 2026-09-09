(function(root,factory){
  const core=typeof module!=="undefined"&&module.exports?require("./go-core.js"):root.NcGoCore;
  const fast=typeof module!=="undefined"&&module.exports?require("./go-fastboard.js"):root.NcGoFastBoard;
  const api=factory(core,fast);
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  root.NcGoFastPlayout=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(C,F){
  "use strict";

  const EMPTY=0,PASS=-1;

  // One board per size, reused across playouts. Playouts are never reentrant, so this is safe and it
  // keeps the whole rollout allocation-free.
  const POOL=new Map(),BUF=new Map();
  function pooled(size){
    let fb=POOL.get(size);
    if(!fb){fb=F.create(size);POOL.set(size,fb)}
    return fb;
  }
  function buffers(size){
    let b=BUF.get(size);
    if(!b){b={local:new Int32Array(8),atari:new Int32Array(8)};BUF.set(size,b)}
    return b;
  }

  const playable=(fb,p,color,ko)=>p!==ko&&fb.color[p]===EMPTY&&!F.isSimpleEye(fb,p,color)&&F.classify(fb,p,color)>0;

  // Same MoGo-style priority the reference playout uses: answer atari around the last move, then play
  // somewhere in its eight-neighbourhood, then anywhere at random.
  function step(fb,color,ko,lastMove,random,buf){
    if(lastMove>=0){
      const{nb,nbStart,a8,a8Start}=fb.t;
      let n=0;
      const consider=v=>{
        if(fb.color[v]===EMPTY)return;
        const liberty=F.ataryLiberty(fb,v);
        if(liberty>=0)buf.atari[n++]=liberty;
      };
      consider(lastMove);
      for(let i=nbStart[lastMove],e=nbStart[lastMove+1];i<e;i++)consider(nb[i]);
      for(let i=n-1;i>0;i--){const j=(random()*(i+1))|0;const t=buf.atari[i];buf.atari[i]=buf.atari[j];buf.atari[j]=t}
      for(let i=0;i<n;i++)if(playable(fb,buf.atari[i],color,ko))return buf.atari[i];

      const s=a8Start[lastMove],e=a8Start[lastMove+1];
      let m=0;
      for(let i=s;i<e;i++)buf.local[m++]=a8[i];
      for(let i=m-1;i>0;i--){const j=(random()*(i+1))|0;const t=buf.local[i];buf.local[i]=buf.local[j];buf.local[j]=t}
      for(let i=0;i<m;i++)if(playable(fb,buf.local[i],color,ko))return buf.local[i];
    }
    // The empty list is shuffled once when the board is loaded, so a rotation is enough here and the
    // whole scan is O(1) in the common case instead of the O(points) reshuffle it replaces.
    const count=fb.nEmpty;
    if(!count)return PASS;
    const start=(random()*count)|0;
    for(let i=0;i<count;i++){
      const p=fb.empties[start+i<count?start+i:start+i-count];
      if(playable(fb,p,color,ko))return p;
    }
    return PASS;
  }

  function shuffleEmpties(fb,random){
    const e=fb.empties,at=fb.emptyAt;
    for(let i=fb.nEmpty-1;i>0;i--){
      const j=(random()*(i+1))|0,t=e[i];
      e[i]=e[j];e[j]=t;at[e[i]]=i;at[e[j]]=j;
    }
  }

  // `amaf`, when supplied, records which colour first played each point — the statistic RAVE needs.
  function playout(state,random,{maxMoves=null,amaf=null}={}){
    const size=state.size,fb=pooled(size),buf=buffers(size);
    F.load(fb,state.board,state.ko);
    shuffleEmpties(fb,random);
    const limit=maxMoves??size*size*2;
    let color=state.toPlay,ko=state.ko,passes=state.passes,moves=0,lastMove=state.lastMove;
    while(passes<2&&moves<limit){
      const point=step(fb,color,ko,lastMove,random,buf);
      if(point!==PASS){
        passes=0;
        if(amaf&&amaf[point]===0)amaf[point]=color;
        ko=F.play(fb,point,color);
      }else{passes++;ko=PASS}
      lastMove=point;color=3-color;moves++;
    }
    return F.score(fb,state.komi);
  }

  // A playout run purely for its terminal ownership rather than its winner.
  function playoutOwnership(state,random,acc,{maxMoves=null}={}){
    const size=state.size,fb=pooled(size),buf=buffers(size);
    F.load(fb,state.board,state.ko);
    shuffleEmpties(fb,random);
    const limit=maxMoves??size*size*2;
    let color=state.toPlay,ko=state.ko,passes=state.passes,moves=0,lastMove=state.lastMove;
    while(passes<2&&moves<limit){
      const point=step(fb,color,ko,lastMove,random,buf);
      if(point!==PASS){passes=0;ko=F.play(fb,point,color)}
      else{passes++;ko=PASS}
      lastMove=point;color=3-color;moves++;
    }
    F.accumulateOwnership(fb,acc);
  }

  return{playout,playoutOwnership,pooled,step};
});
