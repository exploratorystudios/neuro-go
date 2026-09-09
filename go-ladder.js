(function(root,factory){
  const core=typeof module!=="undefined"&&module.exports?require("./go-core.js"):root.NcGoCore;
  const api=factory(core);
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  root.NcGoLadder=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(C){
  "use strict";

  const{EMPTY,PASS,other,tables,collectGroup,libertiesAtLeast,libertyPoints,placeStone,isLegalPlacement}=C;

  // A ladder is the one tactic a rollout engine reliably gets wrong. Random continuations make a
  // doomed escape look survivable, because the attacker in a playout does not reliably keep chasing,
  // and the `rescue` prior then pays the engine to run — one stone at a time, across the whole board,
  // into a capture that was decided at the first move. This layer reads the sequence out exactly.
  //
  // Exactly, and not heuristically: a ladder is a forced sequence, so it can be searched to a terminal
  // answer rather than estimated. What it is not is a general tactical search — it only ever considers
  // the escaper extending or capturing, and the attacker atariing, which is precisely what makes it
  // cheap enough to consult from inside the priors.

  // One scratch board per (size, depth) so a read allocates nothing. Reads are never reentrant.
  const STACK=new Map();
  function boards(size,depth){
    const key=`${size}:${depth}`;
    let board=STACK.get(key);
    if(!board){board=new Int8Array(size*size);STACK.set(key,board)}
    return board;
  }

  const DEFAULT_DEPTH=64,DEFAULT_BUDGET=400;

  // Does the group containing `point` die, with `attackerToMove` deciding who plays next?
  // `work` carries the remaining node budget: a read that runs out of budget answers "escapes",
  // because the guard must never invent a capture it did not actually see.
  function captured(board,size,neighbors,point,depth,attackerToMove,work){
    if(depth>=DEFAULT_DEPTH||--work.left<0)return false;
    const colour=board[point];
    if(colour===EMPTY)return true; // already taken off the board
    const attacker=other(colour);

    if(attackerToMove){
      // Three liberties is out of ladder range: the chase needs a group that stays in atari.
      const liberties=libertyPoints(board,neighbors,point,3);
      if(liberties.length>=3)return false;
      if(liberties.length<=1)return true; // capturable outright next move
      for(const move of liberties){
        if(!isLegalPlacement(board,neighbors,move,attacker))continue;
        const next=boards(size,depth+1);
        next.set(board);
        placeStone(next,neighbors,move,attacker);
        // An attacker stone played into atari is simply taken; that branch is not a ladder.
        if(libertiesAtLeast(next,neighbors,move,2)<2)continue;
        if(captured(next,size,neighbors,point,depth+1,false,work))return true;
      }
      return false;
    }

    const liberties=libertyPoints(board,neighbors,point,2);
    if(liberties.length>=2)return false;   // out of atari: the ladder is over and the group lived
    if(liberties.length===0)return true;

    // The escaper has two ways out, and skipping the second is how a ladder reader tells you a group
    // dies when in fact it takes the chasing stones off the board first — the ladder breaker.
    const seen=new Set();
    for(const q of neighbors[point]===undefined?[]:adjacentEnemies(board,neighbors,point,attacker,seen)){
      const next=boards(size,depth+1);
      next.set(board);
      if(!isLegalPlacement(board,neighbors,q,colour))continue;
      placeStone(next,neighbors,q,colour);
      if(!captured(next,size,neighbors,point,depth+1,true,work))return false;
    }

    const escape=liberties[0];
    if(!isLegalPlacement(board,neighbors,escape,colour))return true;
    const next=boards(size,depth+1);
    next.set(board);
    placeStone(next,neighbors,escape,colour);
    return captured(next,size,neighbors,escape,depth+1,true,work);
  }

  // The liberties of every enemy chain touching this group that is itself in atari: capturing one is
  // the escaper's other move.
  function adjacentEnemies(board,neighbors,point,attacker,seen){
    const group=collectGroup(board,neighbors,point,6),out=[];
    for(const stone of group.stones){
      for(const q of neighbors[stone]){
        if(board[q]!==attacker||seen.has(q))continue;
        const chain=collectGroup(board,neighbors,q,7);
        for(const s of chain.stones)seen.add(s);
        if(chain.liberties!==1)continue;
        const point=libertyPoints(board,neighbors,q,1)[0];
        if(point!==undefined)out.push(point);
      }
    }
    return out;
  }

  function read(board,size,point,{attackerToMove=true,budget=DEFAULT_BUDGET}={}){
    if(board[point]===EMPTY)return false;
    const{neighbors}=tables(size);
    return captured(board,size,neighbors,point,0,attackerToMove,{left:budget});
  }

  // The two questions the engine actually asks.

  // "If I play here, does the stone I just played get chased down?" A move whose own group ends up
  // ladder-captured is a move that hands over stones, whatever the rest of the priors think of it.
  const SELF=new Map();
  function selfAtariLadder(state,point,colour,options){
    const size=state.size,{neighbors}=tables(size);
    let board=SELF.get(size);
    if(!board){board=new Int8Array(size*size);SELF.set(size,board)}
    board.set(state.board);
    if(!isLegalPlacement(board,neighbors,point,colour))return false;
    placeStone(board,neighbors,point,colour);
    // Only a group left short of liberties can be laddered; anything freer is not worth a read.
    if(libertiesAtLeast(board,neighbors,point,3)>=3)return false;
    return read(board,size,point,{...options,attackerToMove:true});
  }

  // "If I atari there, is it a ladder I actually win?" The mirror question, and the reason the guard
  // makes the engine play better rather than merely play safer.
  function laddersEnemy(state,point,colour,options){
    const size=state.size,{neighbors}=tables(size),enemy=other(colour);
    let board=SELF.get(size);
    if(!board){board=new Int8Array(size*size);SELF.set(size,board)}
    board.set(state.board);
    if(!isLegalPlacement(board,neighbors,point,colour))return false;
    placeStone(board,neighbors,point,colour);
    if(libertiesAtLeast(board,neighbors,point,2)<2)return false; // we would just be taken
    const seen=new Set();
    for(const q of neighbors[point]){
      if(board[q]!==enemy||seen.has(q))continue;
      const chain=collectGroup(board,neighbors,q,6);
      for(const s of chain.stones)seen.add(s);
      if(chain.liberties!==1)continue;
      // The enemy is in atari and it is their move: do they run out of it, or is this a ladder?
      if(read(board,size,q,{...options,attackerToMove:false}))return true;
    }
    return false;
  }

  return{read,captured,selfAtariLadder,laddersEnemy,DEFAULT_DEPTH,DEFAULT_BUDGET};
});
