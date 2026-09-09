#!/usr/bin/env node
"use strict";
const C=require("../go-core.js");
const PL=require("../go-players.js");

// Head-to-head between two internal policies. Colours alternate so komi cannot flatter either side.
function playGame(a,b,options,index){
  const random=C.rng((options.seed+index*7919)>>>0);
  const black=index%2===0?a:b,white=index%2===0?b:a;
  const minds={[C.BLACK]:null,[C.WHITE]:null};
  let state=C.createState(options.size,{komi:options.komi,moveCap:options.size*options.size*3});
  while(!state.gameOver){
    const side=state.toPlay===C.BLACK?black:white;
    const decision=PL.POLICIES[side.policy](state,random,{playouts:side.playouts,raveBias:side.raveBias,regionStrength:side.regionStrength,mind:minds[state.toPlay],seed:options.seed+index});
    if(decision.mind)minds[state.toPlay]=decision.mind;
    let point=decision.point;
    if(point!==C.PASS&&!C.isLegal(state,point))point=C.PASS;
    const next=C.play(state,point);
    if(!next)break;
    state=next;
  }
  const result=C.score(state);
  const aMargin=(index%2===0?1:-1)*result.margin;
  return{game:index+1,aColor:index%2===0?"black":"white",aMargin:Number(aMargin.toFixed(1)),
    winner:aMargin>0?"a":"b",moves:state.moveNumber,trompTaylor:`B${result.black} W${result.white}`};
}

function main(){
  const argv=process.argv.slice(2),value=(n,f)=>{const i=argv.indexOf(`--${n}`);return i<0?f:argv[i+1]};
  const options={games:Number(value("games",4)),size:Number(value("size",9)),komi:Number(value("komi",7.5)),seed:Number(value("seed",1))};
  const a={policy:value("a","flat"),playouts:Number(value("a-playouts",4000)),raveBias:Number(value("a-rave",.015)),regionStrength:Number(value("a-region",.8))};
  const b={policy:value("b","random"),playouts:Number(value("b-playouts",0)),raveBias:Number(value("b-rave",.015)),regionStrength:Number(value("b-region",.8))};
  const games=[];
  for(let i=0;i<options.games;i++){
    games.push(playGame(a,b,options,i));
    const g=games[i];
    console.log(`${g.game}/${options.games} A(${a.policy}) as ${g.aColor}: ${g.winner==="a"?"win":"loss"} by ${Math.abs(g.aMargin)} (${g.moves} moves, ${g.trompTaylor})`);
  }
  const wins=games.filter(g=>g.winner==="a").length;
  const avg=games.reduce((n,g)=>n+g.aMargin,0)/games.length;
  console.log(`\nA=${a.policy}${a.playouts?`(${a.playouts})`:""} vs B=${b.policy}${b.playouts?`(${b.playouts})`:""}: ${wins}/${games.length}, average margin ${avg.toFixed(1)} points`);
}
if(require.main===module)main();
module.exports={playGame};
