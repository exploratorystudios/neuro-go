"use strict";
// The style axes, in one place. Both the corpus profiler and the arena measure play this way, which
// is what makes "the Brawler makes contact 8% more often than stock" a comparison rather than a
// coincidence of two similar-looking definitions.
const C=require("../../go-core.js");
const Pat=require("../../go-patterns.js");

const AXES=["contact","answer","tenuki","edge","third","center","capture","atari","rescue",
  "selfAtari","connect","liberties","openingEdge","openingCenter","length","margin"];
const OPENING=12;

function chebyshev(size,a,b){
  return Math.max(Math.abs(Math.floor(a/size)-Math.floor(b/size)),Math.abs(a%size-b%size));
}

function newAccumulator(){
  return{sums:Object.fromEntries(AXES.map(a=>[a,0])),moves:0,openingMoves:0};
}

// Fold one move, already known legal, into a side's accumulator.
function observe(acc,state,point,color,previousOwn){
  const f=Pat.features(state,point,color,state.lastMove);
  const size=state.size;
  acc.moves++;
  acc.sums.contact+=f.contact>0?1:0;
  acc.sums.answer+=Number.isFinite(f.distance)&&f.distance<=2?1:0;
  acc.sums.tenuki+=previousOwn===null?0:(chebyshev(size,point,previousOwn)>=4?1:0);
  acc.sums.edge+=f.line<=1?1:0;
  acc.sums.third+=f.line===2?1:0;
  acc.sums.center+=f.line>=3?1:0;
  acc.sums.capture+=f.capture>0?1:0;
  acc.sums.atari+=f.threaten>0?1:0;
  acc.sums.rescue+=f.rescue>0?1:0;
  acc.sums.selfAtari+=f.selfAtari?1:0;
  acc.sums.connect+=f.friendly>0?1:0;
  acc.sums.liberties+=Math.min(f.liberties,6);
  if(acc.moves<=OPENING){
    acc.openingMoves++;
    acc.sums.openingEdge+=f.line<=1?1:0;
    acc.sums.openingCenter+=f.line>=3?1:0;
  }
}

function finish(acc,{margin=0}={}){
  if(!acc.moves)return null;
  const vector={};
  for(const axis of AXES)vector[axis]=acc.sums[axis]/acc.moves;
  vector.openingEdge=acc.openingMoves?acc.sums.openingEdge/acc.openingMoves:0;
  vector.openingCenter=acc.openingMoves?acc.sums.openingCenter/acc.openingMoves:0;
  vector.length=acc.moves;
  vector.margin=margin;
  return vector;
}

// Profile both sides of a finished move list.
function profile(moves,{komi=7.5,size=9,margin=0}={}){
  let state=C.createState(size,{komi,rules:"simple-ko",moveCap:size*size*3});
  const acc={[C.BLACK]:newAccumulator(),[C.WHITE]:newAccumulator()};
  const previous={[C.BLACK]:null,[C.WHITE]:null};
  for(const point of moves){
    const color=state.toPlay;
    if(point!==C.PASS){
      observe(acc[color],state,point,color,previous[color]);
      previous[color]=point;
    }
    const next=C.play(state,point);
    if(!next)break;
    state=next;
  }
  return{
    black:finish(acc[C.BLACK],{margin}),
    white:finish(acc[C.WHITE],{margin:-margin})
  };
}

module.exports={AXES,OPENING,newAccumulator,observe,finish,profile,chebyshev};
