#!/usr/bin/env node
"use strict";
// Turn a directory of SGF records into one compact JSONL index of the games worth learning from.
//
//   node tools/sgf-index.cjs --records go-records --out data/games.jsonl
//
// The filter is the point of this step. A game with no RE property did not reach a score: on this
// server that is a resignation, a timeout or an abandonment, and its last stretch of moves is either
// missing or played by someone who had already given up. Style learned from those tails is style
// learned from noise, so only scored games are kept.
const fs=require("fs"),path=require("path");
const C=require("../go-core.js");
const S=require("../go-sgf.js");

const argv=process.argv.slice(2);
const arg=(name,fallback)=>{const i=argv.indexOf(`--${name}`);return i<0?fallback:argv[i+1]};
const flag=name=>argv.includes(`--${name}`);

const recordsDir=path.resolve(arg("records","go-records"));
const outPath=path.resolve(arg("out","data/games.jsonl"));
const boardSize=Number(arg("size",9));
const minMoves=Number(arg("min-moves",20));
const keepBots=flag("keep-bots");

function main(){
  const files=fs.readdirSync(recordsDir).filter(name=>name.endsWith(".sgf"));
  const stats={files:files.length,parsed:0,unscored:0,wrongSize:0,tooShort:0,bots:0,illegal:0,kept:0};
  const out=fs.createWriteStream(outPath);
  for(const name of files){
    let game;
    try{game=S.parse(fs.readFileSync(path.join(recordsDir,name),"utf8"))}catch{game=null}
    if(!game){stats.illegal++;continue}
    stats.parsed++;
    if(game.size!==boardSize){stats.wrongSize++;continue}
    if(!game.result||!game.result.scored){stats.unscored++;continue}
    if(game.moves.length<minMoves){stats.tooShort++;continue}
    if(!keepBots&&(game.black.bot||game.white.bot)){stats.bots++;continue}
    // Verify before trusting: a record that does not replay legally is a record we cannot learn from.
    const replayed=S.replay(game);
    if(!replayed.complete){stats.illegal++;continue}
    out.write(JSON.stringify({
      id:name.replace(/\.sgf$/,""),
      komi:game.komi,
      b:game.black.name,br:game.black.rating,
      w:game.white.name,wr:game.white.rating,
      winner:game.result.winner===C.BLACK?"b":"w",
      margin:game.result.margin,
      moves:game.moves.map(m=>m.point)
    })+"\n");
    stats.kept++;
  }
  out.end();
  out.on("close",()=>{
    console.log(`indexed ${stats.kept} games -> ${path.relative(process.cwd(),outPath)}`);
    for(const [key,value] of Object.entries(stats))console.log(`  ${key.padEnd(10)} ${value}`);
  });
}
main();
