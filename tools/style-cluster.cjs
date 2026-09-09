#!/usr/bin/env node
"use strict";
// Discover play-style archetypes by clustering players, not games.
//
//   node tools/style-cluster.cjs --k 5 --min-games 20
//
// Two things keep this from inventing personalities out of thin air:
//   * Reliability weighting. Each axis is measured for how much of its between-player variance
//     survives a split-half of that player's own games. An axis that does not replicate within a
//     player is noise, and noise scaled to unit variance would otherwise pull the clusters as hard
//     as signal does. Each z-scored axis is multiplied by its corrected split-half reliability.
//   * Strength is not style. `margin` replicates at .89 because it measures how strong someone is;
//     clustering on it would sort the corpus into good and bad players and call that personality.
const fs=require("fs"),path=require("path");

const argv=process.argv.slice(2);
const arg=(name,fallback)=>{const i=argv.indexOf(`--${name}`);return i<0?fallback:argv[i+1]};

const stylesPath=path.resolve(arg("game-styles","data/game-styles.jsonl"));
const axesPath=path.resolve(arg("players","data/player-styles.json"));
const outPath=path.resolve(arg("out","data/personality-clusters.json"));
const K=Number(arg("k",5));
const MIN_GAMES=Number(arg("min-games",20));
const RESTARTS=Number(arg("restarts",40));
const SEED=Number(arg("seed",7));
const EXCLUDE=new Set(String(arg("exclude","margin")).split(",").filter(Boolean));
const MIN_RELIABILITY=Number(arg("min-reliability",.25));

const mean=a=>a.reduce((s,x)=>s+x,0)/(a.length||1);
function corr(x,y){
  const mx=mean(x),my=mean(y);
  let n=0,dx=0,dy=0;
  for(let i=0;i<x.length;i++){n+=(x[i]-mx)*(y[i]-my);dx+=(x[i]-mx)**2;dy+=(y[i]-my)**2}
  return dx&&dy?n/Math.sqrt(dx*dy):0;
}
function rng(seed){let v=seed>>>0;return()=>{v=(Math.imul(v,1664525)+1013904223)>>>0;return v/4294967296}}

function load(){
  const axes=JSON.parse(fs.readFileSync(axesPath,"utf8")).axes;
  const rows=fs.readFileSync(stylesPath,"utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line));
  const by=new Map();
  for(const row of rows){
    let list=by.get(row.name);
    if(!list){list=[];by.set(row.name,list)}
    list.push(row);
  }
  return{axes,rows,by};
}

// Split-half reliability, Spearman-Brown corrected, per axis.
function reliability(axes,players){
  return axes.map((_,i)=>{
    const A=[],B=[];
    for(const games of players){
      A.push(mean(games.filter((_,k)=>k%2).map(r=>r.v[i])));
      B.push(mean(games.filter((_,k)=>k%2===0).map(r=>r.v[i])));
    }
    const r=corr(A,B);
    return Math.max(0,2*r/(1+r));
  });
}

function kmeans(points,k,draw,restarts){
  let best=null;
  for(let attempt=0;attempt<restarts;attempt++){
    // k-means++ seeding: the first centre is random, each next is drawn in proportion to its
    // squared distance from the centres already chosen.
    const centres=[points[(draw()*points.length)|0].slice()];
    while(centres.length<k){
      const d2=points.map(p=>Math.min(...centres.map(c=>dist2(p,c))));
      const total=d2.reduce((s,x)=>s+x,0)||1;
      let r=draw()*total,index=0;
      while(index<points.length-1&&(r-=d2[index])>0)index++;
      centres.push(points[index].slice());
    }
    let assign=new Array(points.length).fill(-1),moved=true,rounds=0;
    while(moved&&rounds++<100){
      moved=false;
      for(let i=0;i<points.length;i++){
        let bestIndex=0,bestDistance=Infinity;
        for(let c=0;c<k;c++){const d=dist2(points[i],centres[c]);if(d<bestDistance){bestDistance=d;bestIndex=c}}
        if(assign[i]!==bestIndex){assign[i]=bestIndex;moved=true}
      }
      const sums=centres.map(c=>new Array(c.length).fill(0)),counts=new Array(k).fill(0);
      for(let i=0;i<points.length;i++){
        counts[assign[i]]++;
        for(let d=0;d<points[i].length;d++)sums[assign[i]][d]+=points[i][d];
      }
      for(let c=0;c<k;c++){
        if(!counts[c]){centres[c]=points[(draw()*points.length)|0].slice();moved=true;continue}
        for(let d=0;d<centres[c].length;d++)centres[c][d]=sums[c][d]/counts[c];
      }
    }
    let inertia=0;
    for(let i=0;i<points.length;i++)inertia+=dist2(points[i],centres[assign[i]]);
    if(!best||inertia<best.inertia)best={inertia,assign:assign.slice(),centres:centres.map(c=>c.slice())};
  }
  return best;
}
function dist2(a,b){let s=0;for(let i=0;i<a.length;i++)s+=(a[i]-b[i])**2;return s}

// A label a person can argue with: the axes this cluster is furthest from the corpus average on.
const PHRASE={
  contact:["fights at contact","avoids contact"],
  answer:["answers locally","ignores the last move"],
  tenuki:["jumps around the board","plays where it just played"],
  edge:["hugs the edge","stays off the edge"],
  third:["builds on the third line","skips the third line"],
  center:["plays the centre","stays low"],
  capture:["takes stones","leaves stones alone"],
  atari:["hunts atari","rarely ataris"],
  rescue:["saves its own","abandons its own"],
  selfAtari:["throws stones in","never sacrifices"],
  connect:["plays solidly connected","plays loose shapes"],
  liberties:["keeps its stones breathing","plays into tight spots"],
  openingEdge:["opens on the edge","opens away from the edge"],
  openingCenter:["opens toward the centre","opens low"],
  length:["plays long games","finishes early"]
};
function describe(axes,zCentre,weights){
  const ranked=axes.map((axis,i)=>({axis,z:zCentre[i],w:weights[i]}))
    .filter(x=>x.w>0)
    .sort((a,b)=>Math.abs(b.z)-Math.abs(a.z));
  return ranked.slice(0,4).map(x=>{
    const phrase=PHRASE[x.axis];
    return phrase?phrase[x.z>=0?0:1]:`${x.axis} ${x.z>=0?"high":"low"}`;
  });
}

function main(){
  const{axes,rows,by}=load();
  const names=[...by.keys()].filter(name=>by.get(name).length>=MIN_GAMES);
  const games=names.map(name=>by.get(name));
  const rel=reliability(axes,games);
  // Axis weights: reliability, zeroed for axes that are excluded outright or that do not replicate.
  const weights=axes.map((axis,i)=>EXCLUDE.has(axis)||rel[i]<MIN_RELIABILITY?0:rel[i]);
  const raw=games.map(list=>axes.map((_,i)=>mean(list.map(r=>r.v[i]))));
  const mu=axes.map((_,i)=>mean(raw.map(v=>v[i])));
  const sd=axes.map((_,i)=>Math.sqrt(mean(raw.map(v=>(v[i]-mu[i])**2)))||1);
  const points=raw.map(v=>v.map((x,i)=>weights[i]?(x-mu[i])/sd[i]*weights[i]:0));

  const result=kmeans(points,K,rng(SEED),RESTARTS);
  const clusters=[];
  for(let c=0;c<K;c++){
    const members=names.map((name,i)=>({name,index:i})).filter(x=>result.assign[x.index]===c);
    // Report the centre in the original units, and in unweighted z so the description is honest.
    const centreRaw=axes.map((_,i)=>mean(members.map(m=>raw[m.index][i])));
    const centreZ=axes.map((_,i)=>(centreRaw[i]-mu[i])/sd[i]);
    const gameCount=members.reduce((s,m)=>s+games[m.index].length,0);
    const wins=members.reduce((s,m)=>s+games[m.index].filter(g=>g.won).length,0);
    const ratings=members.flatMap(m=>games[m.index].map(g=>g.rating).filter(Boolean));
    clusters.push({
      id:c,
      label:describe(axes,centreZ,weights).join(", "),
      players:members.length,
      games:gameCount,
      winRate:Number((wins/Math.max(1,gameCount)).toFixed(3)),
      rating:ratings.length?Math.round(mean(ratings)):null,
      centre:Object.fromEntries(axes.map((a,i)=>[a,Number(centreRaw[i].toFixed(4))])),
      z:Object.fromEntries(axes.map((a,i)=>[a,Number(centreZ[i].toFixed(2))])),
      members:members.map(m=>({name:m.name,games:games[m.index].length}))
        .sort((a,b)=>b.games-a.games)
    });
  }
  clusters.sort((a,b)=>b.games-a.games);
  const payload={
    axes,
    reliability:Object.fromEntries(axes.map((a,i)=>[a,Number(rel[i].toFixed(3))])),
    weights:Object.fromEntries(axes.map((a,i)=>[a,Number(weights[i].toFixed(3))])),
    mean:Object.fromEntries(axes.map((a,i)=>[a,Number(mu[i].toFixed(4))])),
    sd:Object.fromEntries(axes.map((a,i)=>[a,Number(sd[i].toFixed(4))])),
    k:K,minGames:MIN_GAMES,seed:SEED,inertia:Number(result.inertia.toFixed(3)),
    coveredPlayers:names.length,coveredSides:rows.length,
    clusters
  };
  fs.writeFileSync(outPath,JSON.stringify(payload,null,1));
  console.log(`clustered ${names.length} players (>=${MIN_GAMES} games) into ${K} archetypes`);
  console.log(`  axes used: ${axes.filter((_,i)=>weights[i]>0).join(" ")}`);
  for(const c of clusters){
    console.log(`\n  [${c.id}] ${c.label}`);
    console.log(`      ${c.players} players, ${c.games} games, win ${(c.winRate*100).toFixed(0)}%, avg rating ${c.rating}`);
    console.log(`      ${axes.filter((_,i)=>weights[i]>0).map(a=>`${a}:${c.z[a]>=0?"+":""}${c.z[a]}`).join(" ")}`);
    console.log(`      e.g. ${c.members.slice(0,6).map(m=>`${m.name}(${m.games})`).join(" ")}`);
  }
  console.log(`\n  -> ${path.relative(process.cwd(),outPath)}`);
}
main();
