#!/usr/bin/env node
"use strict";

const fs=require("node:fs");
const path=require("node:path");
const{fork}=require("node:child_process");
const C=require("../go-core.js");
const PL=require("../go-players.js");
const{startGnuGo}=require("../gtp.js");
const{performanceRating,scoreInterval,ratingAt}=require("../rating-math.js");

function parseArgs(argv){
  const value=(name,fallback)=>{const i=argv.indexOf(`--${name}`);return i<0?fallback:argv[i+1]};
  const size=Number(value("size",9)),handicap=Number(value("handicap",0));
  const komiGiven=argv.includes("--komi");
  return{
    games:Number(value("games",10)),size,
    komi:komiGiven?Number(value("komi",7.5)):(handicap>0?.5:7.5),
    level:Number(value("level",10)),anchor:Number(value("anchor",1800)),handicap,
    policy:value("policy","random"),playouts:Number(value("playouts",2000)),
    cPuct:Number(value("cpuct",1.2)),fpuReduction:Number(value("fpu",.2)),
    raveBias:Number(value("rave",.015)),expandThreshold:Number(value("expand-threshold",6)),
    eyeMode:value("eyes","root"),eyeWeight:Number(value("eye-weight",1.1)),
    fastPlayouts:value("fast-playouts","true")!=="false",
    moveCap:Number(value("move-cap",size*size*3)),seed:Number(value("seed",1)),
    gnugo:value("gnugo",process.env.GNUGO_PATH||"gnugo"),workers:Number(value("workers",1)),
    report:value("report","NCGO-BASELINE-REPORT.md"),json:value("json","ncgo-baseline-results.json"),
    verbose:argv.includes("--verbose")
  };
}

// GNU Go arbitrates its own rules; a move our positional superko rejects is still played on the board.
function forcePlay(state,point){
  const next=C.play(state,point);
  if(next)return{state:next,forced:false};
  if(point===C.PASS)return null;
  const relaxed=C.play({...state,rules:"simple-ko"},point);
  return relaxed?{state:{...relaxed,rules:state.rules},forced:true}:null;
}
function fallbackMove(state){
  const moves=C.legalMoves(state,{includePass:false}),{neighbors,diagonals}=C.tables(state.size);
  const sensible=moves.filter(p=>!C.isSimpleEye(state.board,neighbors,diagonals,p,state.toPlay));
  return sensible.length?sensible[0]:C.PASS;
}

async function playGame(options,index){
  // Handicap stones are always Black's, so a handicap game cannot alternate colours.
  const ourColor=options.handicap>0?C.BLACK:(index%2===0?C.BLACK:C.WHITE),theirColor=C.other(ourColor);
  const{engine,name}=await startGnuGo({binary:options.gnugo,level:options.level,size:options.size,komi:options.komi,seed:options.seed+index});
  const random=C.rng((options.seed+index*7919)>>>0);
  let state=C.createState(options.size,{komi:options.komi,moveCap:options.moveCap});
  const moves=[];let resigned=null,forcedMoves=0,playouts=0,illegalPicks=0,mind=null;
  const plans={};
  try{
    if(options.handicap>0){
      const stones=await engine.send(`fixed_handicap ${options.handicap}`);
      for(const vertex of stones.split(/\s+/).filter(Boolean)){
        const point=C.gtpToVertex(options.size,vertex);
        state=forcePlay(state,point).state;state={...state,toPlay:C.BLACK};
      }
      state={...state,toPlay:C.WHITE};
    }
    while(!state.gameOver){
      if(state.toPlay===ourColor){
        const decision=PL.POLICIES[options.policy](state,random,{playouts:options.playouts,mind,seed:options.seed+index,
          cPuct:options.cPuct,fpuReduction:options.fpuReduction,raveBias:options.raveBias,expandThreshold:options.expandThreshold,
          eyeMode:options.eyeMode,eyeWeight:options.eyeWeight,fastPlayouts:options.fastPlayouts});
        if(decision.mind)mind=decision.mind;
        if(decision.stats?.plan)plans[decision.stats.plan]=(plans[decision.stats.plan]||0)+1;
        playouts+=decision.stats?.playouts||0;
        let point=decision.point;
        if(point!==C.PASS&&!C.isLegal(state,point)){illegalPicks++;point=fallbackMove(state)}
        const applied=forcePlay(state,point);
        if(!applied)break;
        state=applied.state;
        moves.push(`${C.colorName(ourColor)[0]} ${C.vertexToGtp(options.size,point)}`);
        await engine.send(`play ${C.colorName(ourColor)[0]} ${C.vertexToGtp(options.size,point)}`);
      }else{
        const reply=await engine.send(`genmove ${C.colorName(theirColor)[0]}`);
        if(reply.toLowerCase()==="resign"){resigned=theirColor;break}
        const point=C.gtpToVertex(options.size,reply);
        if(point===null)break;
        const applied=forcePlay(state,point);
        if(!applied)break;
        if(applied.forced)forcedMoves++;
        state=applied.state;
        moves.push(`${C.colorName(theirColor)[0]} ${C.vertexToGtp(options.size,point)}`);
      }
    }
    const ours=C.score(state);
    let engineScore=null;
    try{engineScore=await engine.send("final_score")}catch{}
    const winner=resigned?C.other(resigned):ours.winner;
    return{game:index+1,engine:name,ourColor:C.colorName(ourColor),
      result:winner===ourColor?1:0,reason:resigned?"resignation":state.result||"unfinished",
      margin:Number(ours.margin.toFixed(1)),
      aiMargin:Number((ourColor===C.BLACK?ours.margin:-ours.margin).toFixed(1)),
      trompTaylor:`B${ours.black} W${ours.white} komi ${ours.komi}`,
      engineScore,moveCount:state.moveNumber,forcedMoves,illegalPicks,playouts,plans,moves};
  }finally{await engine.close()}
}

function childGame(options,index){
  return new Promise((resolve,reject)=>{
    const child=fork(__filename,[],{env:{...process.env,NCGO_RATING_WORKER:JSON.stringify({options,index})},stdio:["ignore","ignore","inherit","ipc"]});
    let result=null;
    child.on("message",message=>{result=message});child.on("error",reject);
    child.on("exit",code=>code===0&&result?resolve(result):reject(new Error(`Rating worker ${index+1} exited with code ${code}`)));
  });
}

function summarise(games,options,seconds){
  const wins=games.filter(g=>g.result===1).length,losses=games.length-wins,points=wins;
  // A performance rating is only meaningful in an even game: a handicap has already paid the rating
  // difference in stones, so anchoring the score to an even-game Elo would double-count the compensation.
  const even=options.handicap===0;
  const perf=even?performanceRating(options.anchor,points,games.length):null;
  const interval=scoreInterval(points,games.length);
  return{engine:games[0]?.engine||"gnugo",level:options.level,anchorElo:options.anchor,handicap:options.handicap,
    boardSize:options.size,komi:options.komi,policy:options.policy,
    playoutsPerMove:options.policy==="random"?null:options.playouts,
    search:{cPuct:options.cPuct,fpuReduction:options.fpuReduction,raveBias:options.raveBias,expandThreshold:options.expandThreshold,
      eyeMode:options.eyeMode,eyeWeight:options.eyeWeight,fastPlayouts:options.fastPlayouts},
    games:games.length,wins,losses,points,score:Number((points/games.length).toFixed(4)),
    performanceElo:perf===null?null:Math.round(perf),
    ratingApplicable:even,
    scoreInterval:{low:Number(interval.low.toFixed(4)),high:Number(interval.high.toFixed(4)),confidence:.95,kind:interval.kind},
    ratingInterval:even?{low:Number.isFinite(ratingAt(options.anchor,interval.low))?Math.round(ratingAt(options.anchor,interval.low)):null,
      high:Number.isFinite(ratingAt(options.anchor,interval.high))?Math.round(ratingAt(options.anchor,interval.high)):null,
      confidence:.95,kind:interval.kind}:null,
    averageMoves:Number((games.reduce((n,g)=>n+g.moveCount,0)/games.length).toFixed(1)),
    averageMargin:Number((games.reduce((n,g)=>n+g.aiMargin,0)/games.length).toFixed(1)),
    bestMargin:Number(Math.max(...games.map(g=>g.aiMargin)).toFixed(1)),
    forcedMoves:games.reduce((n,g)=>n+g.forcedMoves,0),illegalPicks:games.reduce((n,g)=>n+g.illegalPicks,0),
    totalPlayouts:games.reduce((n,g)=>n+g.playouts,0),seconds:Number(seconds.toFixed(2))};
}

function report(summary,games){
  const pct=(summary.score*100).toFixed(1);
  const verdict=!summary.ratingApplicable
    ?`The AI scored **${summary.points}/${summary.games} (${pct}%)** receiving **${summary.handicap} handicap stones**. No Elo is
reported: the handicap has already paid the strength difference in stones, so anchoring this score to an
even-game rating would count that compensation twice. The measurement here is the handicap itself — find the
stone count that yields 50% and that is the gap, in stones, to this opponent.`
    :summary.performanceElo===null
      ?(summary.points===0
        ?`The AI scored no points. The 95% one-sided result is **below ${summary.ratingInterval.high} Elo** on this anchor.`
        :`The AI won every game, so the result is above the tested anchor.`)
      :`The measured performance rating is **${summary.performanceElo} Elo**, with a 95% interval of **${summary.ratingInterval.low}–${summary.ratingInterval.high}**.`;
  return `# Neuro-Cognitive Go Baseline Report

Generated ${new Date().toISOString()}. Base Go only — no cards, no variant rules. Colours alternate game by game.

## Result

${verdict}

| Measure | Result |
| --- | ---: |
| Opponent | ${summary.engine} level ${summary.level} |
| Anchor Elo (assumed) | ${summary.anchorElo} |
| Board / komi | ${summary.boardSize}x${summary.boardSize} / ${summary.komi} |
| Handicap | ${summary.handicap?`${summary.handicap} stones (AI plays Black every game)`:"none"} |
| Policy | ${summary.policy}${summary.playoutsPerMove?` (${summary.playoutsPerMove} playouts/move)`:""} |
| AI wins / losses | ${summary.wins} / ${summary.losses} |
| AI score | ${summary.points} / ${summary.games} (${(summary.score*100).toFixed(1)}%) |
| Average game length | ${summary.averageMoves} moves |
| Average final margin (AI perspective) | ${summary.averageMargin} points |
| Best single game (AI perspective) | ${summary.bestMargin} points |
| Forced moves (superko mismatch) | ${summary.forcedMoves} |
| Illegal policy picks | ${summary.illegalPicks} |
| Runtime | ${summary.seconds}s |

## Interpretation

**The anchor is an assumption, not a calibration.** GNU Go exposes \`level 1..10\` as a strength dial with no
published Elo mapping, unlike Stockfish's \`UCI_Elo\`. Every rating here is a performance rating *relative to
an assumed anchor of ${summary.anchorElo} Elo for GNU Go ${summary.level ? `level ${summary.level}` : ""}*; changing the anchor shifts every number by the same
amount. Treat the score percentage as the primary measurement and the Elo as a derived convenience until the
anchor is verified against a public rating pool. The 1800 default is reasoned for **level 10** specifically,
so a report run at another level is quoting an anchor that was never argued for that setting.

Scoring is Tromp-Taylor area scoring on the final position with no dead-stone removal, so games must be played
to completion for the score to be meaningful. GNU Go's own \`final_score\` is recorded per game as a cross-check.

## Games

| # | AI | Result | End | AI margin | Tromp-Taylor | GNU Go score | Moves |
| ---: | --- | ---: | --- | ---: | --- | --- | ---: |
${games.map(g=>`| ${g.game} | ${g.ourColor} | ${g.result?"win":"loss"} | ${g.reason} | ${g.aiMargin} | ${g.trompTaylor} | ${g.engineScore||"n/a"} | ${g.moveCount} |`).join("\n")}
`;
}

async function main(){
  const options=parseArgs(process.argv.slice(2)),started=Date.now(),games=[];
  if(options.workers>1){
    const queue=[...Array(options.games).keys()];
    await Promise.all(Array.from({length:Math.min(options.workers,options.games)},async()=>{
      while(queue.length){const index=queue.shift();games[index]=await childGame(options,index);
        console.log(`${index+1}/${options.games} AI ${games[index].ourColor}: ${games[index].result?"win":"loss"} (${games[index].reason}, ${games[index].moveCount} moves)`)}
    }));
  }else{
    for(let i=0;i<options.games;i++){
      games[i]=await playGame(options,i);
      console.log(`${i+1}/${options.games} AI ${games[i].ourColor}: ${games[i].result?"win":"loss"} (${games[i].reason}, ${games[i].moveCount} moves)`);
      if(options.verbose)console.log(games[i].moves.join(" "));
    }
  }
  const summary=summarise(games,options,(Date.now()-started)/1000);
  fs.writeFileSync(path.resolve(options.json),JSON.stringify({summary,games},null,2));
  fs.writeFileSync(path.resolve(options.report),report(summary,games));
  console.log(`\n${summary.wins}/${summary.games} (${(summary.score*100).toFixed(1)}%) -> ${!summary.ratingApplicable?`${summary.handicap} stones (no Elo in a handicap game)`:summary.performanceElo===null?`bound ${summary.ratingInterval.low}-${summary.ratingInterval.high}`:`${summary.performanceElo} Elo`}`);
  console.log(`Wrote ${options.report} and ${options.json}`);
}

if(process.env.NCGO_RATING_WORKER){
  const{options,index}=JSON.parse(process.env.NCGO_RATING_WORKER);
  playGame(options,index).then(game=>{if(process.send)process.send(game)}).catch(error=>{console.error(error);process.exit(1)});
}else if(require.main===module){
  main().catch(error=>{console.error(error);process.exit(1)});
}

module.exports={parseArgs,playGame,summarise,report,forcePlay};
