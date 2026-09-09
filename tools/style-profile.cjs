#!/usr/bin/env node
"use strict";
// Measure how each side actually played, one vector per (game, colour), aggregated per player.
//
//   node tools/style-profile.cjs --games data/games.jsonl --out data/player-styles.json
//
// Every dimension is computed from the same `go-patterns` features the engine's own priors are built
// from. That is deliberate: a style axis the feature set cannot express is a style the engine has no
// way to imitate, so measuring one would only produce archetypes it can't play.
const fs=require("fs"),path=require("path");
const C=require("../go-core.js");
const Metrics=require("./lib/style-metrics.cjs");

const argv=process.argv.slice(2);
const arg=(name,fallback)=>{const i=argv.indexOf(`--${name}`);return i<0?fallback:argv[i+1]};

const gamesPath=path.resolve(arg("games","data/games.jsonl"));
const outPath=path.resolve(arg("out","data/player-styles.json"));
const gameOutPath=path.resolve(arg("game-out","data/game-styles.jsonl"));

const AXES=Metrics.AXES;

// One game, both sides, measured with the shared definitions in tools/lib/style-metrics.cjs.
function profileGame(record){
  const profiled=Metrics.profile(record.moves,{komi:record.komi,margin:record.winner==="b"
    ?Math.abs(record.margin):-Math.abs(record.margin)});
  const out={};
  for(const[key,side]of[["b",profiled.black],["w",profiled.white]]){
    if(!side||side.length<10){out[key]=null;continue}
    out[key]={vector:side,moves:side.length,won:record.winner===key,margin:side.margin};
  }
  return out;
}

function main(){
  const lines=fs.readFileSync(gamesPath,"utf8").split("\n").filter(Boolean);
  const players=new Map();
  const gameOut=fs.createWriteStream(gameOutPath);
  let profiled=0;
  for(const line of lines){
    const record=JSON.parse(line);
    const result=profileGame(record);
    for(const key of["b","w"]){
      const side=result[key];
      if(!side)continue;
      profiled++;
      const name=key==="b"?record.b:record.w;
      const rating=key==="b"?record.br:record.wr;
      gameOut.write(JSON.stringify({id:record.id,color:key,name,rating,
        won:side.won,moves:side.moves,v:AXES.map(a=>round(side.vector[a]))})+"\n");
      let entry=players.get(name);
      if(!entry){entry={name,games:0,wins:0,ratingSum:0,ratings:0,sums:Object.fromEntries(AXES.map(a=>[a,0]))};players.set(name,entry)}
      entry.games++;
      if(side.won)entry.wins++;
      if(rating){entry.ratingSum+=rating;entry.ratings++}
      for(const axis of AXES)entry.sums[axis]+=side.vector[axis];
    }
  }
  gameOut.end();
  const profiles=[...players.values()].map(entry=>({
    name:entry.name,games:entry.games,winRate:round(entry.wins/entry.games),
    rating:entry.ratings?Math.round(entry.ratingSum/entry.ratings):null,
    v:AXES.map(axis=>round(entry.sums[axis]/entry.games))
  })).sort((a,b)=>b.games-a.games);
  fs.writeFileSync(outPath,JSON.stringify({axes:AXES,players:profiles},null,1));
  console.log(`profiled ${profiled} sides across ${lines.length} games`);
  console.log(`  ${profiles.length} distinct players -> ${path.relative(process.cwd(),outPath)}`);
  console.log(`  per-game vectors -> ${path.relative(process.cwd(),gameOutPath)}`);
  const top=profiles.slice(0,5);
  console.log(`  axes: ${AXES.join(" ")}`);
  for(const p of top)console.log(`  ${p.name.padEnd(16)} n=${String(p.games).padEnd(4)} ${p.v.join(" ")}`);
}
const round=n=>Math.round(n*1e4)/1e4;
main();
