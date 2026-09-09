"use strict";
// Identical statistics to tools/stockfish-rating.cjs so chess and Go results stay comparable.
function performanceRating(opponentElo,score,games){
  if(score<=0)return null;if(score>=games)return null;
  const p=score/games;return opponentElo+400*Math.log10(p/(1-p));
}
function scoreInterval(score,games){
  if(score===0)return{low:0,high:1-Math.pow(.05,1/games),kind:"one-sided"};
  if(score===games)return{low:Math.pow(.05,1/games),high:1,kind:"one-sided"};
  const p=score/games,z=1.96,den=1+z*z/games,mid=(p+z*z/(2*games))/den,margin=z*Math.sqrt(p*(1-p)/games+z*z/(4*games*games))/den;
  return{low:Math.max(0,mid-margin),high:Math.min(1,mid+margin),kind:"two-sided"};
}
function ratingAt(opponent,p){if(p<=0)return-Infinity;if(p>=1)return Infinity;return opponent+400*Math.log10(p/(1-p))}
module.exports={performanceRating,scoreInterval,ratingAt};
