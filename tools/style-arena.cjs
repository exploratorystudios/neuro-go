#!/usr/bin/env node
"use strict";
// Play personalities against each other and against the stock engine, then report both things that
// matter: whether the style is visible in the moves, and what it costs in strength.
//
//   node tools/style-arena.cjs --a brawler --b none --games 20 --playouts 800
//   node tools/style-arena.cjs --all --games 12 --playouts 600
//
// Imitation and strength pull against each other, and a personality feature that is never measured
// against the engine it modifies is a feature that quietly makes the bot worse. Colours alternate
// every game so neither configuration keeps the first move, and both sides get the same playout
// budget so the comparison is of judgement rather than of time.
const C=require("../go-core.js");
const G=require("../go-cognitive.js");
const PL=require("../go-players.js");
const People=require("../go-personalities.js");
const Metrics=require("./lib/style-metrics.cjs");

const argv=process.argv.slice(2);
const arg=(name,fallback)=>{const i=argv.indexOf(`--${name}`);return i<0?fallback:argv[i+1]};
const flag=name=>argv.includes(`--${name}`);

const GAMES=Number(arg("games",20));
const PLAYOUTS=Number(arg("playouts",800));
const SEED=Number(arg("seed",1));
const STYLE_WEIGHT=Number(arg("style-weight",1));
const PLAYOUT_WEIGHT=Number(arg("playout-weight",1));
const BOOK_WEIGHT=Number(arg("book-weight",1));
const SIZE=9,KOMI=7.5;

function config(id){
  if(!id||id==="none"||id==="stock")return{id:"stock",name:"stock",personality:null};
  const spec=People.describe(id);
  if(!spec)throw new Error(`unknown personality "${id}"; known: ${People.ids().join(", ")||"(none)"}`);
  return{id,name:spec.name,personality:id};
}

function playGame(black,white,seed){
  let state=C.createState(SIZE,{komi:KOMI,moveCap:SIZE*SIZE*3});
  const random=C.rng(seed>>>0);
  const options={styleWeight:STYLE_WEIGHT,bookWeight:BOOK_WEIGHT,playoutWeight:PLAYOUT_WEIGHT};
  const minds={
    [C.BLACK]:G.createMind(C.BLACK,seed,People.resolve(black.personality,options)),
    [C.WHITE]:G.createMind(C.WHITE,seed+1,People.resolve(white.personality,options))
  };
  const moves=[];
  let guard=0;
  while(!state.gameOver&&guard++<SIZE*SIZE*3){
    const side=state.toPlay===C.BLACK?black:white;
    const decision=PL.puctPolicy(state,random,{...options,playouts:PLAYOUTS,mind:minds[state.toPlay],
      personality:side.personality,seed});
    minds[state.toPlay]=decision.mind;
    const next=C.play(state,decision.point);
    if(!next)break;
    moves.push(decision.point);
    state=next;
  }
  const score=C.score(state);
  return{moves,margin:score.margin,winner:score.margin>0?C.BLACK:C.WHITE,length:moves.length};
}

function report(name,rows){
  const axes=Metrics.AXES.filter(a=>a!=="margin");
  const mean=axis=>rows.reduce((s,v)=>s+v[axis],0)/(rows.length||1);
  return Object.fromEntries(axes.map(a=>[a,mean(a)]));
}

function match(a,b,{games=GAMES,label=""}={}){
  const style={[a.id]:[],[b.id]:[]};
  let winsA=0,winsB=0,totalLength=0;
  for(let i=0;i<games;i++){
    // Alternate who holds Black. The first move is worth real points on 9x9 even with komi.
    const aIsBlack=i%2===0;
    const black=aIsBlack?a:b,white=aIsBlack?b:a;
    const result=playGame(black,white,SEED+i*7919);
    const winner=result.winner===C.BLACK?black:white;
    if(winner.id===a.id)winsA++;else winsB++;
    totalLength+=result.length;
    const profiled=Metrics.profile(result.moves,{komi:KOMI,margin:result.margin});
    if(profiled.black)style[black.id].push(profiled.black);
    if(profiled.white)style[white.id].push(profiled.white);
    process.stderr.write(`\r  ${label}${i+1}/${games}  ${a.name} ${winsA} - ${winsB} ${b.name}   `);
  }
  process.stderr.write("\r".padEnd(72)+"\r");
  return{a,b,games,winsA,winsB,rateA:winsA/games,
    // Wilson-free but honest: the standard error of a proportion over this many games. With 20 games
    // it is about 11 points, which is the number to keep in mind before reading anything into a 12-8.
    stderr:Math.sqrt((winsA/games)*(1-winsA/games)/games),
    averageLength:totalLength/games,
    styleA:report(a.name,style[a.id]),styleB:report(b.name,style[b.id])};
}

function printMatch(result){
  const{a,b}=result;
  console.log(`\n${a.name} vs ${b.name} — ${result.winsA}-${result.winsB} over ${result.games} games ` +
    `(${(result.rateA*100).toFixed(0)}% ± ${(result.stderr*100).toFixed(0)}), avg ${result.averageLength.toFixed(0)} moves`);
  const axes=["contact","atari","capture","edge","center","openingCenter","tenuki","answer","selfAtari","liberties"];
  console.log(`  ${"axis".padEnd(15)}${a.name.slice(0,10).padStart(10)}${b.name.slice(0,10).padStart(10)}${"delta".padStart(10)}`);
  for(const axis of axes){
    const x=result.styleA[axis],y=result.styleB[axis];
    const delta=x-y;
    const mark=Math.abs(delta)>=(axis==="liberties"?.08:.02)?"  <=":"";
    console.log(`  ${axis.padEnd(15)}${x.toFixed(3).padStart(10)}${y.toFixed(3).padStart(10)}${(delta>=0?"+":"")+delta.toFixed(3)}`.padEnd(55)+mark);
  }
}

function main(){
  if(!People.loaded()){
    console.error("No personalities found. Run: npm run go:style");
    process.exit(1);
  }
  console.log(`arena: ${PLAYOUTS} playouts/move, style weight ${STYLE_WEIGHT}, playout bias ${PLAYOUT_WEIGHT}`);
  if(flag("all")){
    const stock=config("none"),table=[];
    for(const id of People.ids()){
      const result=match(config(id),stock,{label:`${id} `});
      printMatch(result);
      table.push(result);
    }
    console.log(`\nsummary vs stock (${GAMES} games each)`);
    for(const r of table){
      console.log(`  ${r.a.name.padEnd(13)} ${String(r.winsA).padStart(2)}-${String(r.winsB).padEnd(2)}  ` +
        `${(r.rateA*100).toFixed(0)}% ± ${(r.stderr*100).toFixed(0)}`);
    }
    return;
  }
  printMatch(match(config(arg("a","brawler")),config(arg("b","none"))));
}
main();
