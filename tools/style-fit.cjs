#!/usr/bin/env node
"use strict";
// Fit one move model per archetype and write the personality tables the engine plays with.
//
//   node tools/style-fit.cjs --positions 30000 --out data/personalities.json
//
// The model is a conditional logit over the legal moves of a position: the probability a player
// chooses a move is the softmax of a linear score over exactly the features `go-patterns` already
// computes, plus a weight for the canonical 3x3 shape being played into. Fitting it on one
// archetype's games answers "what did these players like that the average player did not".
//
// Everything is stored as a difference from a pooled baseline fitted the same way over every
// archetype's positions together. That matters for two reasons. It makes a personality a tilt rather
// than a replacement, so the engine's own hand-authored judgement still carries the move; and it
// makes `--style-weight 0` exactly the stock engine, which is what makes the arena comparison mean
// anything.
const fs=require("fs"),path=require("path");
const C=require("../go-core.js");
const Pat=require("../go-patterns.js");
const St=require("../go-style.js");

const argv=process.argv.slice(2);
const arg=(name,fallback)=>{const i=argv.indexOf(`--${name}`);return i<0?fallback:argv[i+1]};

const gamesPath=path.resolve(arg("games","data/games.jsonl"));
const clustersPath=path.resolve(arg("clusters","data/personality-clusters.json"));
const outPath=path.resolve(arg("out","data/personalities.json"));
const POSITIONS=Number(arg("positions",30000));
const MIN_SUPPORT=Number(arg("min-support",150));
const MAX_PATTERNS=Number(arg("max-patterns",2500));
const BOOK_DEPTH=Number(arg("book-depth",16));
const BOOK_MIN=Number(arg("book-min",8));
const EPOCHS=Number(arg("epochs",24));
const LR=Number(arg("lr",.06));
const L2_DENSE=Number(arg("l2",2e-4));
const L2_PATTERN=Number(arg("l2-pattern",4e-3));
const SEED=Number(arg("seed",11));
const HOLDOUT=Number(arg("holdout",.2));

const SIZE=9;
const DENSE=["capture","rescue","threaten","selfAtari","contact","friendly","liberty",
  "line0","line1","line2","line3","line4","near1","near2","near3","near4","near5"];
const D=DENSE.length;

function rng(seed){let v=seed>>>0;return()=>{v=(Math.imul(v,1664525)+1013904223)>>>0;return v/4294967296}}

// ---------------------------------------------------------------------------------------------
// Dataset extraction
// ---------------------------------------------------------------------------------------------
// One row per legal candidate move, kept in the raw units the features come in; the design vector is
// expanded inside the training loop instead of being stored. 1.5M rows of 13 bytes rather than 1.5M
// rows of 68, which is the difference between fitting in memory and not.
function newDataset(){
  return{start:[0],chosen:[],cap:[],resc:[],thr:[],self:[],cont:[],frnd:[],lib:[],line:[],dist:[],pat:[]};
}
function pushRow(ds,f,key){
  ds.cap.push(Math.min(f.capture,60));ds.resc.push(Math.min(f.rescue,60));ds.thr.push(Math.min(f.threaten,60));
  ds.self.push(f.selfAtari?1:0);ds.cont.push(f.contact);ds.frnd.push(f.friendly);
  ds.lib.push(Math.min(f.liberties,60));ds.line.push(Math.min(f.line,4));
  ds.dist.push(Number.isFinite(f.distance)?Math.min(f.distance,5):-1);
  ds.pat.push(key);
}
function freeze(ds){
  return{
    positions:ds.start.length-1,
    rows:ds.chosen.length?ds.cap.length:0,
    start:Int32Array.from(ds.start),chosen:Int32Array.from(ds.chosen),
    cap:Int8Array.from(ds.cap),resc:Int8Array.from(ds.resc),thr:Int8Array.from(ds.thr),
    self:Int8Array.from(ds.self),cont:Int8Array.from(ds.cont),frnd:Int8Array.from(ds.frnd),
    lib:Int8Array.from(ds.lib),line:Int8Array.from(ds.line),dist:Int8Array.from(ds.dist),
    pat:Int32Array.from(ds.pat)
  };
}

// Walk one game, contributing the positions where `side` was to move and `keep` says so.
function extract(record,side,ds,keep,book){
  let state=C.createState(SIZE,{komi:record.komi,rules:"simple-ko",moveCap:SIZE*SIZE*3});
  const colour=side==="b"?C.BLACK:C.WHITE;
  for(const point of record.moves){
    const toPlay=state.toPlay;
    if(toPlay===colour&&point!==C.PASS){
      if(book&&state.moveNumber<BOOK_DEPTH){
        const{key,transform}=St.canonicalBoard(state.board,SIZE,toPlay);
        let entry=book.get(key);
        if(!entry){entry=new Map();book.set(key,entry)}
        const canonical=St.mapPoint(SIZE,point,transform);
        entry.set(canonical,(entry.get(canonical)||0)+1);
      }
      if(keep()){
        const{neighbors,diagonals}=C.tables(SIZE);
        const candidates=[];
        for(let p=0;p<state.board.length;p++){
          if(!C.isLegal(state,p))continue;
          // A player never has to explain why they did not fill their own eye, so those moves are not
          // part of the choice being modelled.
          if(p!==point&&C.isSimpleEye(state.board,neighbors,diagonals,p,toPlay))continue;
          candidates.push(p);
        }
        const index=candidates.indexOf(point);
        if(index>=0&&candidates.length>1){
          ds.chosen.push(index);
          for(const p of candidates)pushRow(ds,Pat.features(state,p,toPlay,state.lastMove),
            St.patternKey(state.board,SIZE,p,toPlay));
          ds.start.push(ds.cap.length);
        }
      }
    }
    const next=C.play(state,point);
    if(!next)break;
    state=next;
  }
}

// ---------------------------------------------------------------------------------------------
// Conditional logit
// ---------------------------------------------------------------------------------------------
// The design vector, expanded from the stored raw fields. Kept in one place so the trainer and the
// runtime in go-style.js cannot drift apart.
function accumulate(ds,row,out,scale){
  out[0]+=scale*Math.log1p(ds.cap[row]);
  out[1]+=scale*Math.log1p(ds.resc[row]);
  out[2]+=scale*Math.log1p(ds.thr[row]);
  out[3]+=scale*ds.self[row];
  out[4]+=scale*Math.min(ds.cont[row],2);
  out[5]+=scale*Math.min(ds.frnd[row],2);
  out[6]+=scale*Math.min(ds.lib[row],4);
  out[7+ds.line[row]]+=scale;
  if(ds.dist[row]>=1)out[12+ds.dist[row]-1]+=scale;
}
function rowScore(ds,row,theta,patternIndex,patternWeights){
  let s=theta[0]*Math.log1p(ds.cap[row])+theta[1]*Math.log1p(ds.resc[row])+theta[2]*Math.log1p(ds.thr[row])
    +theta[3]*ds.self[row]+theta[4]*Math.min(ds.cont[row],2)+theta[5]*Math.min(ds.frnd[row],2)
    +theta[6]*Math.min(ds.lib[row],4)+theta[7+ds.line[row]];
  if(ds.dist[row]>=1)s+=theta[12+ds.dist[row]-1];
  const p=patternIndex.get(ds.pat[row]);
  if(p!==undefined)s+=patternWeights[p];
  return s;
}

function buildVocabulary(ds){
  const counts=new Map();
  for(let i=0;i<ds.pat.length;i++)counts.set(ds.pat[i],(counts.get(ds.pat[i])||0)+1);
  const index=new Map(),keys=[],support=[];
  for(const[key,count]of counts){
    if(count<MIN_SUPPORT)continue;
    index.set(key,keys.length);keys.push(key);support.push(count);
  }
  return{index,keys,support};
}

// Positions are split by index parity of a hash so the same position always lands on the same side
// of the split, whichever model is being fitted.
function split(ds,holdout){
  const train=[],test=[];
  for(let i=0;i<ds.positions;i++){
    const h=Math.imul(i+1,0x9e3779b1)>>>8;
    ((h%1000)/1000<holdout?test:train).push(i);
  }
  return{train:Int32Array.from(train),test:Int32Array.from(test)};
}

function train(ds,vocab,{epochs=EPOCHS,lr=LR,seed=SEED,indices=null}={}){
  const theta=new Float64Array(D),patternWeights=new Float64Array(vocab.keys.length);
  const mT=new Float64Array(D),vT=new Float64Array(D);
  const mP=new Float64Array(vocab.keys.length),vP=new Float64Array(vocab.keys.length);
  const order=indices?Int32Array.from(indices):Int32Array.from({length:ds.positions},(_,i)=>i);
  const draw=rng(seed);
  const batch=256,beta1=.9,beta2=.999,eps=1e-8;
  const gT=new Float64Array(D),touched=new Map();
  const scores=new Float64Array(512);
  let step=0,loss=0;
  for(let epoch=0;epoch<epochs;epoch++){
    for(let i=order.length-1;i>0;i--){const j=(draw()*(i+1))|0;const t=order[i];order[i]=order[j];order[j]=t}
    loss=0;
    for(let b=0;b<order.length;b+=batch){
      gT.fill(0);touched.clear();
      const end=Math.min(b+batch,order.length),n=end-b;
      for(let k=b;k<end;k++){
        const pos=order[k],from=ds.start[pos],to=ds.start[pos+1],count=to-from;
        if(scores.length<count)continue;
        let max=-Infinity;
        for(let r=0;r<count;r++){const s=rowScore(ds,from+r,theta,vocab.index,patternWeights);scores[r]=s;if(s>max)max=s}
        let total=0;
        for(let r=0;r<count;r++){scores[r]=Math.exp(scores[r]-max);total+=scores[r]}
        const chosen=from+ds.chosen[pos];
        loss-=Math.log(Math.max(1e-12,scores[ds.chosen[pos]]/total));
        // Gradient of the log-likelihood: the chosen move's features minus their expectation.
        accumulate(ds,chosen,gT,1/n);
        const cp=vocab.index.get(ds.pat[chosen]);
        if(cp!==undefined)touched.set(cp,(touched.get(cp)||0)+1/n);
        for(let r=0;r<count;r++){
          const p=scores[r]/total;
          if(p<1e-6)continue;
          accumulate(ds,from+r,gT,-p/n);
          const pi=vocab.index.get(ds.pat[from+r]);
          if(pi!==undefined)touched.set(pi,(touched.get(pi)||0)-p/n);
        }
      }
      step++;
      const correction1=1-Math.pow(beta1,step),correction2=1-Math.pow(beta2,step);
      for(let d=0;d<D;d++){
        const g=gT[d]-L2_DENSE*theta[d];
        mT[d]=beta1*mT[d]+(1-beta1)*g;vT[d]=beta2*vT[d]+(1-beta2)*g*g;
        theta[d]+=lr*(mT[d]/correction1)/(Math.sqrt(vT[d]/correction2)+eps);
      }
      // Sparse Adam: only the patterns this batch actually saw are updated, with their own decay.
      for(const[pi,g0]of touched){
        const g=g0-L2_PATTERN*patternWeights[pi];
        mP[pi]=beta1*mP[pi]+(1-beta1)*g;vP[pi]=beta2*vP[pi]+(1-beta2)*g*g;
        patternWeights[pi]+=lr*(mP[pi]/correction1)/(Math.sqrt(vP[pi]/correction2)+eps);
      }
    }
    loss/=order.length;
  }
  return{theta,patternWeights,loss};
}

// Mean log-likelihood per position, for reporting: how much better than uniform the model is.
function evaluate(ds,theta,vocab,patternWeights,indices=null){
  let loss=0,uniform=0,counted=0;
  const scores=new Float64Array(512);
  const list=indices||Int32Array.from({length:ds.positions},(_,i)=>i);
  for(const pos of list){
    const from=ds.start[pos],to=ds.start[pos+1],count=to-from;
    if(count>scores.length)continue;
    let max=-Infinity;
    for(let r=0;r<count;r++){const s=rowScore(ds,from+r,theta,vocab.index,patternWeights);scores[r]=s;if(s>max)max=s}
    let total=0;
    for(let r=0;r<count;r++){scores[r]=Math.exp(scores[r]-max);total+=scores[r]}
    loss-=Math.log(Math.max(1e-12,scores[ds.chosen[pos]]/total));
    uniform-=Math.log(1/count);
    counted++;
  }
  return{logLoss:loss/counted,uniform:uniform/counted,positions:counted};
}

// ---------------------------------------------------------------------------------------------
// Naming and plan seeds
// ---------------------------------------------------------------------------------------------
// Names are derived from the archetype's own z-scores rather than typed in by hand, so re-running the
// clusterer with different settings renames them instead of silently mislabelling them.
const ARCHETYPES=[
  {name:"Brawler",     slug:"brawler",     score:z=>1.1*z.contact+z.atari+z.capture-.5*z.liberties},
  {name:"Skydiver",    slug:"skydiver",    score:z=>1.2*z.openingCenter+z.center-.8*z.edge},
  {name:"Landgrabber", slug:"landgrabber", score:z=>1.2*z.openingEdge+z.edge-.8*z.center+.5*z.tenuki},
  {name:"Architect",   slug:"architect",   score:z=>z.liberties+z.connect-1.1*z.contact-.8*z.atari},
  {name:"Grinder",     slug:"grinder",     score:z=>z.length+z.selfAtari-.5*z.answer},
  {name:"Sentinel",    slug:"sentinel",    score:z=>z.answer+z.rescue-z.tenuki},
  {name:"Wanderer",    slug:"wanderer",    score:z=>z.tenuki-z.answer-.5*z.contact}
];
function nameArchetypes(clusters){
  const taken=new Set(),names=[];
  // Assign greedily by confidence, so the most distinctive cluster gets first pick of the names.
  const ranked=clusters.map((c,i)=>{
    const scored=ARCHETYPES.map(a=>({a,value:a.score(c.z)})).sort((x,y)=>y.value-x.value);
    return{i,scored,margin:scored[0].value-scored[1].value};
  }).sort((a,b)=>b.margin-a.margin);
  for(const entry of ranked){
    const pick=entry.scored.find(s=>!taken.has(s.a.slug))||entry.scored[0];
    taken.add(pick.a.slug);
    names[entry.i]={name:pick.a.name,slug:pick.a.slug};
  }
  return names;
}

// The cognitive layer's plans, seeded from the same z-scores. A personality that fights should begin
// its game already believing in `attack`, rather than rediscovering that from scratch every match.
function planSeeds(z){
  const seed=(x)=>Math.max(.05,Math.min(.9,.2+.22*x));
  return{
    expand:seed(z.center+z.openingCenter+.5*z.tenuki),
    enclose:seed(z.edge+z.openingEdge+z.third),
    attack:seed(z.contact+z.atari+z.capture),
    defend:seed(z.rescue+z.liberties-z.selfAtari),
    endgame:seed(z.length+z.edge),
    live:seed(z.liberties+z.connect-z.selfAtari),
    kill:seed(z.capture+z.atari)
  };
}

// ---------------------------------------------------------------------------------------------
function main(){
  const clustersFile=JSON.parse(fs.readFileSync(clustersPath,"utf8"));
  const records=fs.readFileSync(gamesPath,"utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line));
  const clusters=clustersFile.clusters;
  const memberOf=new Map();
  for(const cluster of clusters)for(const member of cluster.members)memberOf.set(member.name,cluster.id);

  // Which sides belong to which archetype.
  const sides=new Map(clusters.map(c=>[c.id,[]]));
  for(const record of records){
    for(const side of["b","w"]){
      const name=side==="b"?record.b:record.w;
      const id=memberOf.get(name);
      if(id!==undefined)sides.get(id).push({record,side});
    }
  }

  const names=nameArchetypes(clusters);
  const fitted=[];
  for(let index=0;index<clusters.length;index++){
    const cluster=clusters[index],list=sides.get(cluster.id);
    const draw=rng(SEED+cluster.id);
    // Positions are sampled rather than taken in order: an archetype's games are not interchangeable
    // move by move, and taking the first N would fit the opening and nothing else.
    const perSide=list.length?Math.min(1,POSITIONS/(list.length*20)):0;
    const ds=newDataset(),book=new Map();
    for(const{record,side}of list)extract(record,side,ds,()=>draw()<perSide,book);
    const frozen=freeze(ds);
    process.stdout.write(`[${cluster.id}] ${names[index].name.padEnd(12)} ${String(list.length).padStart(5)} sides  ${String(frozen.positions).padStart(6)} positions  ${String(frozen.rows).padStart(8)} candidates\n`);
    fitted.push({cluster,name:names[index],ds:frozen,book,sides:list.length});
  }

  // The pooled baseline: the same model fitted to every archetype's positions at once. Personalities
  // are stored as the difference from it.
  //
  // Equal positions from each archetype, not all of them. Weighting the baseline by cluster size
  // makes it approximately the largest cluster's own model, and the largest cluster's personality
  // then measures as no personality at all. The baseline wanted here is the average *archetype*.
  const cap=Math.min(...fitted.map(f=>f.ds.positions));
  const pooled=mergeDatasets(fitted.map(f=>f.ds),cap);
  const vocab=buildVocabulary(pooled);
  console.log(`\npooled baseline: ${cap} positions from each archetype, ${pooled.positions} total, ${pooled.rows} candidates, ${vocab.keys.length} patterns with >=${MIN_SUPPORT} support`);
  const pooledSplit=split(pooled,HOLDOUT);
  const base=train(pooled,vocab,{indices:pooledSplit.train});
  const baseScore=evaluate(pooled,base.theta,vocab,base.patternWeights,pooledSplit.test);
  console.log(`baseline held-out log-loss ${baseScore.logLoss.toFixed(4)} over ${baseScore.positions} positions (uniform ${baseScore.uniform.toFixed(4)})`);

  const personalities=[];
  for(const entry of fitted){
    // Fitted on this archetype's training positions, scored on positions no model has seen. A
    // personality that only looks like a personality in sample is a personality that does not exist.
    const parts=split(entry.ds,HOLDOUT);
    const model=train(entry.ds,vocab,{seed:SEED+entry.cluster.id,indices:parts.train});
    const own=evaluate(entry.ds,model.theta,vocab,model.patternWeights,parts.test);
    const underBase=evaluate(entry.ds,base.theta,vocab,base.patternWeights,parts.test);
    const z=entry.cluster.z;
    // Deltas: what this archetype wants that the average player does not.
    const delta=Array.from(model.theta,(v,i)=>v-base.theta[i]);
    const patterns={};
    const ranked=vocab.keys.map((key,i)=>({key,
      value:model.patternWeights[i]-base.patternWeights[i],support:vocab.support[i]}))
      .filter(p=>Math.abs(p.value)>.02)
      .sort((a,b)=>Math.abs(b.value)*Math.log1p(b.support)-Math.abs(a.value)*Math.log1p(a.support))
      .slice(0,MAX_PATTERNS);
    for(const p of ranked)patterns[p.key]=Number(p.value.toFixed(3));
    const bookOut={};
    let bookEntries=0;
    for(const[key,moves]of entry.book){
      const total=[...moves.values()].reduce((s,x)=>s+x,0);
      if(total<BOOK_MIN)continue;
      bookOut[key]=[...moves.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6);
      bookEntries++;
    }
    personalities.push({
      id:entry.name.slug,
      name:entry.name.name,
      label:entry.cluster.label,
      cluster:entry.cluster.id,
      weights:unpack(delta),
      patterns,
      book:bookOut,
      plans:planSeeds(z),
      traits:z,
      stats:{
        players:entry.cluster.players,games:entry.cluster.games,sides:entry.sides,
        rating:entry.cluster.rating,winRate:entry.cluster.winRate,
        positions:entry.ds.positions,heldOut:own.positions,
        logLoss:Number(own.logLoss.toFixed(4)),
        baselineLogLoss:Number(underBase.logLoss.toFixed(4)),
        uniformLogLoss:Number(underBase.uniform.toFixed(4)),
        patterns:Object.keys(patterns).length,
        bookEntries
      }
    });
    entry.model=model;entry.parts=parts;entry.own=own;
    const gain=underBase.logLoss-own.logLoss;
    console.log(`  ${entry.name.name.padEnd(12)} held-out ${own.logLoss.toFixed(4)} vs baseline ${underBase.logLoss.toFixed(4)}  (gain ${gain>=0?"+":""}${gain.toFixed(4)})  ${Object.keys(patterns).length} patterns, ${bookEntries} book entries`);
  }

  // Discrimination: every archetype's model scored on every archetype's held-out positions. The
  // question a baseline comparison cannot answer is whether these models are telling each other
  // apart, or all just re-learning "play a good move". The diagonal has to win its column.
  console.log("\nheld-out log-loss, model (row) on archetype (column) — lower is better");
  const header=fitted.map(f=>f.name.name.slice(0,9).padStart(10)).join("");
  console.log(`${"".padEnd(13)}${header}`);
  const matrix=[];
  let diagonalWins=0;
  for(const modelEntry of fitted){
    const row=fitted.map(target=>evaluate(target.ds,modelEntry.model.theta,vocab,
      modelEntry.model.patternWeights,target.parts.test).logLoss);
    matrix.push(row);
    console.log(`${modelEntry.name.name.padEnd(13)}${row.map(v=>v.toFixed(4).padStart(10)).join("")}`);
  }
  for(let column=0;column<fitted.length;column++){
    let best=0;
    for(let row=1;row<fitted.length;row++)if(matrix[row][column]<matrix[best][column])best=row;
    if(best===column)diagonalWins++;
  }
  console.log(`  own model best on own positions: ${diagonalWins}/${fitted.length} archetypes`);

  fs.writeFileSync(outPath,JSON.stringify({
    generated:new Date().toISOString(),
    source:{games:records.length,clusters:clustersPath},
    baseline:{weights:unpack(Array.from(base.theta)),logLoss:Number(baseScore.logLoss.toFixed(4))},
    discrimination:{order:fitted.map(f=>f.name.slug),
      matrix:matrix.map(row=>row.map(v=>Number(v.toFixed(4)))),diagonalWins},
    personalities
  },null,1));
  const bytes=fs.statSync(outPath).size;
  console.log(`\n-> ${path.relative(process.cwd(),outPath)} (${(bytes/1024).toFixed(0)} KB)`);
}

function unpack(theta){
  return{
    capture:round(theta[0]),rescue:round(theta[1]),threaten:round(theta[2]),selfAtari:round(theta[3]),
    contact:round(theta[4]),friendly:round(theta[5]),liberty:round(theta[6]),
    line:[round(theta[7]),round(theta[8]),round(theta[9]),round(theta[10]),round(theta[11])],
    near:[0,round(theta[12]),round(theta[13]),round(theta[14]),round(theta[15]),round(theta[16])]
  };
}
const round=n=>Number(n.toFixed(4));

function mergeDatasets(list,cap=Infinity){
  const take=list.map(d=>Math.min(d.positions,cap));
  const rowsOf=list.map((d,i)=>d.start[take[i]]);
  const total=rowsOf.reduce((s,x)=>s+x,0),positions=take.reduce((s,x)=>s+x,0);
  const out={positions,rows:total,start:new Int32Array(positions+1),chosen:new Int32Array(positions),
    cap:new Int8Array(total),resc:new Int8Array(total),thr:new Int8Array(total),self:new Int8Array(total),
    cont:new Int8Array(total),frnd:new Int8Array(total),lib:new Int8Array(total),line:new Int8Array(total),
    dist:new Int8Array(total),pat:new Int32Array(total)};
  let rowOffset=0,posOffset=0;
  for(let i=0;i<list.length;i++){
    const ds=list[i],rows=rowsOf[i];
    for(const field of["cap","resc","thr","self","cont","frnd","lib","line","dist","pat"])out[field].set(ds[field].subarray(0,rows),rowOffset);
    for(let p=0;p<take[i];p++){
      out.start[posOffset+p]=ds.start[p]+rowOffset;
      out.chosen[posOffset+p]=ds.chosen[p];
    }
    rowOffset+=rows;posOffset+=take[i];
  }
  out.start[positions]=rowOffset;
  return out;
}
main();
