(function(root,factory){
  const core=typeof module!=="undefined"&&module.exports?require("./go-core.js"):root.NcGoCore;
  const api=factory(core);
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  root.NcGoEyes=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(C){
  "use strict";

  const EMPTY=0,BLACK=1,WHITE=2;

  // ---------------------------------------------------------------------------------------------
  // Decomposition: every chain, and every maximal empty region with the colours that reach it.
  // ---------------------------------------------------------------------------------------------
  function analyse(board,size){
    const{neighbors}=C.tables(size),points=size*size;
    const chainOf=new Int32Array(points).fill(-1),regionOf=new Int32Array(points).fill(-1);
    const chains=[],regions=[],stack=new Int32Array(points);
    for(let p=0;p<points;p++){
      const color=board[p];
      if(color===EMPTY||chainOf[p]>=0)continue;
      const id=chains.length,stones=[];
      let top=0,libs=0;
      const seenLib=new Set();
      stack[top++]=p;chainOf[p]=id;
      while(top){
        const v=stack[--top];stones.push(v);
        for(const q of neighbors[v]){
          if(board[q]===EMPTY){if(!seenLib.has(q))seenLib.add(q);continue}
          if(board[q]===color&&chainOf[q]<0){chainOf[q]=id;stack[top++]=q}
        }
      }
      libs=seenLib.size;
      chains.push({id,color,stones,liberties:libs,libertyPoints:[...seenLib]});
    }
    for(let p=0;p<points;p++){
      if(board[p]!==EMPTY||regionOf[p]>=0)continue;
      const id=regions.length,cells=[],border=new Set();
      let top=0,reachBlack=false,reachWhite=false;
      stack[top++]=p;regionOf[p]=id;
      while(top){
        const v=stack[--top];cells.push(v);
        for(const q of neighbors[v]){
          const c=board[q];
          if(c===EMPTY){if(regionOf[q]<0){regionOf[q]=id;stack[top++]=q}continue}
          if(c===BLACK)reachBlack=true;else reachWhite=true;
          border.add(chainOf[q]);
        }
      }
      const owner=reachBlack&&!reachWhite?BLACK:reachWhite&&!reachBlack?WHITE:EMPTY;
      regions.push({id,cells,owner,border:[...border],reachBlack,reachWhite});
    }
    return{board,size,points,chains,chainOf,regions,regionOf};
  }

  // ---------------------------------------------------------------------------------------------
  // Benson's algorithm for unconditional life. A chain is pass-alive when it can never be captured,
  // no matter how the opponent plays and even if the owner never answers. This is exact, not a
  // heuristic, which is what makes it safe to act on: it is the only "this group is settled" claim
  // in the whole engine that cannot be wrong.
  //
  // A region enclosed by colour c is *vital* to chain X when every empty point of the region is a
  // liberty of X. Chains with fewer than two vital regions are struck out, regions that lose a
  // bordering chain are struck out, and the process repeats until it stabilises.
  // ---------------------------------------------------------------------------------------------
  function bensonAlive(board,size,color){
    const{neighbors}=C.tables(size),points=size*size;
    const chainOf=new Int32Array(points).fill(-1),chains=[];
    const stack=new Int32Array(points);
    for(let p=0;p<points;p++){
      if(board[p]!==color||chainOf[p]>=0)continue;
      const id=chains.length,stones=[];
      let top=0;
      stack[top++]=p;chainOf[p]=id;
      while(top){
        const v=stack[--top];stones.push(v);
        for(const q of neighbors[v])if(board[q]===color&&chainOf[q]<0){chainOf[q]=id;stack[top++]=q}
      }
      chains.push({id,stones,alive:true,vital:0});
    }
    // Regions here are maximal connected sets of points that are NOT colour c — empty points and
    // enemy stones alike — and only those whose entire boundary is colour c are enclosed.
    const regionOf=new Int32Array(points).fill(-1),regions=[];
    for(let p=0;p<points;p++){
      if(board[p]===color||regionOf[p]>=0)continue;
      const id=regions.length,cells=[],empties=[],border=new Set();
      let top=0;
      stack[top++]=p;regionOf[p]=id;
      while(top){
        const v=stack[--top];cells.push(v);
        if(board[v]===EMPTY)empties.push(v);
        for(const q of neighbors[v]){
          if(board[q]===color){border.add(chainOf[q]);continue}
          if(regionOf[q]<0){regionOf[q]=id;stack[top++]=q}
        }
      }
      // The flood fill absorbs every adjacent non-c point, so a region's boundary is colour c by
      // construction and the board edge acts as a wall. Enclosure needs no separate test.
      regions.push({id,cells,empties,border:[...border],alive:true});
    }
    // A region is vital to a bordering chain when every empty point of the region touches that chain.
    const vitalFor=regions.map(r=>{
      const out=[];
      for(const cid of r.border){
        const stones=new Set(chains[cid].stones);
        let all=true;
        for(const e of r.empties){
          let touches=false;
          for(const q of neighbors[e])if(stones.has(q)){touches=true;break}
          if(!touches){all=false;break}
        }
        if(all)out.push(cid);
      }
      return new Set(out);
    });
    let changed=true;
    while(changed){
      changed=false;
      for(const chain of chains){
        if(!chain.alive)continue;
        let count=0;
        for(let r=0;r<regions.length;r++)if(regions[r].alive&&vitalFor[r].has(chain.id))count++;
        if(count<2){chain.alive=false;changed=true}
      }
      for(const region of regions){
        if(!region.alive)continue;
        // A region only counts while every chain around it is still standing.
        if(region.border.some(cid=>!chains[cid].alive)){region.alive=false;changed=true}
      }
    }
    const flags=new Uint8Array(points);
    for(const chain of chains)if(chain.alive)for(const s of chain.stones)flags[s]=1;
    // Unconditional territory is the *vital* regions only, not every enclosed one. A region that is
    // vital has all of its empty points adjacent to the living chain, so the opponent can never form
    // an eye inside it. Merely being enclosed is not enough: on an otherwise bare board the whole rest
    // of the board is "enclosed" by a single live group, and the opponent can obviously live in it.
    for(let r=0;r<regions.length;r++){
      const region=regions[r];
      if(!region.alive||!vitalFor[r].size)continue;
      let vitalToLiving=false;
      for(const cid of vitalFor[r])if(chains[cid].alive){vitalToLiving=true;break}
      if(!vitalToLiving||!region.border.every(cid=>chains[cid].alive))continue;
      for(const cell of region.cells)flags[cell]=2;
    }
    return flags;
  }


  // ---------------------------------------------------------------------------------------------
  // The graded layer. Benson answers "settled or not" exactly but says nothing while a group is still
  // fighting, which is most of the game. This grades every group by how close it is to two eyes and,
  // crucially, emits the *specific points* that would make or break them.
  //
  // Emitting points rather than a per-area score is deliberate. The regional matrix in `go-regions.js`
  // failed because a per-region scalar could not express anything the per-point pattern priors did not
  // already carry. Eye status is different — nothing in `go-patterns.js` knows what an eye is — but the
  // lesson about grain still holds, so this layer speaks in points, at the same resolution as the prior
  // it feeds.
  // ---------------------------------------------------------------------------------------------

  // How many eyes a clean enclosed space is worth. A one- or two-point space is a single eye; three to
  // five points are one eye that becomes two if the owner gets the dividing point first; six or more is
  // big enough to be split into two eyes even under attack.
  // Size alone is not enough. A square four has four points and is dead — there is no move that makes
  // two eyes from it — while a straight four has the same count and lives. What separates them is
  // whether the space has a point that splits it, so the split is what the value is read from.
  function eyeValue(size,splittable){
    if(size<=0)return 0;
    if(size<=2)return 1;
    // Six clean points can always be divided into two eyes, and so can any larger enclosed space.
    if(size>=6)return 2;
    return splittable?1.5:1;
  }

  // Points inside a space that split it into two or more parts. Playing one is what turns a single
  // large eye into two real eyes, and is equally what kills the group when the opponent gets there.
  function dividingPoints(cells,size,neighbors){
    if(cells.length<3||cells.length>10)return[];
    const set=new Set(cells),out=[];
    for(const candidate of cells){
      const rest=new Set(cells);rest.delete(candidate);
      if(!rest.size)continue;
      const start=rest.values().next().value,seen=new Set([start]),stack=[start];
      while(stack.length){
        const v=stack.pop();
        for(const q of neighbors[v])if(rest.has(q)&&!seen.has(q)){seen.add(q);stack.push(q)}
      }
      // Two surviving parts, each big enough to be an eye.
      if(seen.size<rest.size)out.push(candidate);
    }
    return out;
  }

  function survey(state,color){
    const size=state.size,board=state.board,points=size*size,{neighbors}=C.tables(size);
    const enemy=color===BLACK?WHITE:BLACK;
    const info=analyse(board,size);
    const aliveOwn=bensonAlive(board,size,color),aliveEnemy=bensonAlive(board,size,enemy);
    const settled=new Uint8Array(points);
    for(let p=0;p<points;p++)if(aliveOwn[p]||aliveEnemy[p])settled[p]=1;

    // Group assembly: chains that share an enclosed space of their own colour are one living unit,
    // because whatever eyes that space yields are eyes for all of them.
    const parent=info.chains.map((_,i)=>i);
    const root=i=>{while(parent[i]!==i)i=parent[i]=parent[parent[i]];return i};
    for(const region of info.regions){
      if(region.owner===EMPTY)continue;
      const own=region.border.filter(cid=>info.chains[cid].color===region.owner);
      for(let i=1;i<own.length;i++){const a=root(own[0]),b=root(own[i]);if(a!==b)parent[b]=a}
    }
    const groups=new Map();
    for(const chain of info.chains){
      const key=root(chain.id);
      let g=groups.get(key);
      if(!g){g={id:key,color:chain.color,chains:[],stones:0,liberties:new Set(),spaces:[],eyes:0,benson:false};groups.set(key,g)}
      g.chains.push(chain.id);g.stones+=chain.stones.length;
      for(const l of chain.libertyPoints)g.liberties.add(l);
      if((chain.color===color?aliveOwn:aliveEnemy)[chain.stones[0]]===1)g.benson=true;
    }
    for(const region of info.regions){
      if(region.owner===EMPTY)continue;
      const own=region.border.filter(cid=>info.chains[cid].color===region.owner);
      if(!own.length)continue;
      const g=groups.get(root(own[0]));
      if(g)g.spaces.push(region);
    }

    const vital=new Float32Array(points);
    let ownCritical=0,ownUnsettled=0,enemyCritical=0,enemyUnsettled=0,ownAliveStones=0;
    const add=(p,weight)=>{if(p>=0&&p<points&&board[p]===EMPTY&&vital[p]<weight)vital[p]=weight};

    for(const g of groups.values()){
      const mine=g.color===color;
      // A space only counts as an eye for this group if it is small enough to be one. A vast enclosed
      // area is territory, not life: the opponent can still invade it and build eyes of their own.
      let eyes=0;
      const eyeSpaces=[];
      for(const space of g.spaces){
        // Only a space small enough to be read out has dividing points worth naming.
        const splits=space.cells.length<=10?dividingPoints(space.cells,size,neighbors):[];
        eyes+=eyeValue(space.cells.length,splits.length>0);
        if(splits.length)eyeSpaces.push({space,splits});
      }
      g.eyes=eyes;
      g.libertyCount=g.liberties.size;
      // A group with no enclosed space yet is not in trouble merely for that — in the opening no group
      // has one, because every region still touches both colours. It is in trouble when it has no eye
      // space *and* is running out of room.
      g.status=g.benson||eyes>=2?"alive"
        :eyes>=1?"unsettled"
        :g.libertyCount<=2?"critical"
        :g.libertyCount<=4&&g.stones>=2?"weak"
        :"open";
      if(g.benson){if(mine)ownAliveStones+=g.stones;continue}
      const endangered=g.status==="critical"||g.status==="weak";
      if(mine){if(endangered)ownCritical+=g.stones;else if(g.status==="unsettled")ownUnsettled+=g.stones}
      else{if(endangered)enemyCritical+=g.stones;else if(g.status==="unsettled")enemyUnsettled+=g.stones}
      // An "open" group is simply a stone with room around it, not a life-and-death question. Saying
      // anything about it here would only re-state the contact and liberty terms the pattern priors
      // already carry, which is exactly how the regional matrix went wrong.
      if(g.status==="open")continue;

      // Urgency scales with how much is at stake and how close the group is to settling. Our own
      // groups and the enemy's are worth the same points — taking an eye kills as surely as making one.
      const stake=Math.log1p(g.stones),
        urgency=g.status==="critical"?1.4:g.status==="weak"?1.1:g.status==="unsettled"?1:.5;
      const weight=stake*urgency*(mine?1:.9);

      // 1. The dividing points of our own eye spaces: play here and one eye becomes two.
      for(const{splits}of eyeSpaces)for(const p of splits)add(p,weight*1.3);
      // 2. A group with few liberties is about to be captured whatever its eye shape says.
      if(g.libertyCount<=2)for(const l of g.liberties)add(l,weight*(g.libertyCount===1?1.6:1.1));
      // 3. Otherwise press on the boundary: liberties that touch the other colour are where the
      //    enclosure is still open, and sealing them is what turns loose space into an eye space.
      if(g.libertyCount<=8){
        for(const l of g.liberties){
          let contested=false;
          for(const q of neighbors[l])if(board[q]!==EMPTY&&board[q]!==g.color){contested=true;break}
          if(contested)add(l,weight*.6);
        }
      }
    }

    return{groups:[...groups.values()],vital,settled,
      ownCritical,ownUnsettled,enemyCritical,enemyUnsettled,ownAliveStones,
      aliveOwn,aliveEnemy};
  }

  return{analyse,bensonAlive,survey,eyeValue,dividingPoints,EMPTY,BLACK,WHITE};
});
