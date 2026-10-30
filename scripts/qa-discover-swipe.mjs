import assert from "node:assert/strict";
import { projectMobileDiscoverEvent } from "../lib/discover/mobile-event.ts";
import { getEventPrimaryCategory, getEventTags } from "../lib/taxonomy/event-categories.ts";
import { resolveEventTimePresentation } from "../lib/events/event-time-presentation.ts";
import {
  choicesForScope, completedDiscoverLikes, getDiscoverCategory, markDiscoverCompletion,
  pendingDiscoverSaveIds, readDiscoverSessions, recordDiscoverChoice, restartDiscoverScope, undoDiscoverChoice,
  acknowledgeDiscoverSaves, discoverSessionStorageKey, mergeGuestDiscoverSessions,
  getDiscoverGestureAction,
} from "../lib/discover/swipe-session.ts";

const id = number => number.toString(36).padStart(32,"0");
const choice = (number,category,decision="like") => ({eventId:id(number),category,decision});
let day = recordDiscoverChoice(undefined,choice(1,"club"));
day = recordDiscoverChoice(day,choice(2,"live"));
assert.equal(getDiscoverCategory({eventType:"social"}),"event");
assert.equal(getDiscoverCategory({eventType:"Barovi"}),"event");
assert.equal(getDiscoverCategory({eventType:"event"}),"event");
assert.equal(choicesForScope(day,"club").length,1);
assert.equal(choicesForScope(day,"all").length,2);
assert.deepEqual(completedDiscoverLikes({"2026-10-29":day}),[],"Completion bookkeeping stays separate from immediate save eligibility.");
assert.deepEqual(pendingDiscoverSaveIds({"2026-10-29":day},new Set(),new Set()),[id(1),id(2)],"Every signed-in like queues immediately, before a category or day is finished.");
assert.deepEqual(pendingDiscoverSaveIds(readDiscoverSessions(JSON.stringify({"2026-10-29":day})),new Set(),new Set()),[id(1),id(2)],"Partial guest selections survive auth navigation and replay immediately after sign-in.");
assert.deepEqual(pendingDiscoverSaveIds(mergeGuestDiscoverSessions({},{"2026-10-29":day}),new Set(),new Set()),[id(1),id(2)],"The first authenticated account replays partial guest likes without completing their category.");
assert.equal(markDiscoverCompletion(day,"club",[]),day,"An empty category never completes.");
assert.equal(markDiscoverCompletion(day,"club",[id(1),id(3)]),day,"An unloaded/undecided event prevents completion.");
day = recordDiscoverChoice(day,choice(3,"club","skip"));
day = markDiscoverCompletion(day,"club",[id(1),id(3)]);
let sessions = {"2026-10-29":day};
assert.deepEqual(completedDiscoverLikes(sessions),[id(1),id(2)],"Finishing club queues every liked event for that day, including live.");
sessions = readDiscoverSessions(JSON.stringify(sessions));
assert.deepEqual(pendingDiscoverSaveIds(sessions,new Set(),new Set()),[id(1),id(2)],"Guest choices replay after a reload/sign-in even when another filter is active.");
assert.deepEqual(pendingDiscoverSaveIds(sessions,new Set([id(1)]),new Set([id(2)])),[],"Confirmed ids and an in-flight/failed attempt are not repeatedly saved.");
assert.deepEqual(pendingDiscoverSaveIds(sessions,new Set([id(1)]),new Set()),[id(2)],"Retry queues a failed id without re-saving the confirmed id.");
const acknowledged={"2026-10-29":{...day,acknowledgedIds:[id(1),id(2)]}};
assert.deepEqual(pendingDiscoverSaveIds(readDiscoverSessions(JSON.stringify(acknowledged)),new Set(),new Set()),[],"A reload does not re-save acknowledged likes, including events manually unsaved from Saved.");
const reliked=recordDiscoverChoice(acknowledged["2026-10-29"],choice(1,"club"));
assert.deepEqual(pendingDiscoverSaveIds({"2026-10-29":reliked},new Set(),new Set()),[id(1)],"An explicit fresh like invalidates only that event's previous acknowledgement.");
assert.notEqual(discoverSessionStorageKey("user_a"),discoverSessionStorageKey("user_b"),"Accounts must never share a pending-choice partition.");
assert.notEqual(discoverSessionStorageKey(null),discoverSessionStorageKey("user_a"));
const claimed=mergeGuestDiscoverSessions({},sessions);
assert.deepEqual(completedDiscoverLikes(claimed),[id(1),id(2)],"The first account may claim completed guest likes.");
assert.deepEqual(mergeGuestDiscoverSessions({},{}),{},"After guest choices are cleared, another account has nothing to replay.");
const lateAccountA=acknowledgeDiscoverSaves(claimed,[id(1),id(2)]),accountB={};
assert.deepEqual(pendingDiscoverSaveIds(lateAccountA,new Set(),new Set()),[],"A late confirmed response can acknowledge the originating account without replay after reload.");
assert.deepEqual(accountB,{},"Late acknowledgements never modify another account partition.");
const otherDay = markDiscoverCompletion(recordDiscoverChoice(undefined,choice(4,"culture")),"culture",[id(4)]);
sessions["2026-10-30"] = otherDay;
assert.deepEqual(completedDiscoverLikes(sessions),[id(1),id(2),id(4)],"Changing the selected date retains queued likes for previous dates.");
const undone = undoDiscoverChoice(day,"club");
assert.equal(undone.choices.some(item=>item.eventId===id(3)),false,"Filtered undo removes the last club decision, not the later/other category.");
assert.equal(undone.choices.some(item=>item.eventId===id(2)),true);
const restarted = restartDiscoverScope(day,"club");
assert.deepEqual(restarted.choices,[choice(2,"live")],"Filtered restart keeps other-category likes.");
assert.deepEqual(sessions["2026-10-30"],otherDay,"Restarting one day cannot erase another day.");
assert.deepEqual(restartDiscoverScope(day,"all"),{choices:[],completedScopes:[]});
assert.deepEqual(readDiscoverSessions('{"bad":{"choices":[]}}'),{});
assert.deepEqual(readDiscoverSessions(JSON.stringify({"2026-10-29":{choices:[choice(1,"club"),choice(1,"club"),{...choice(9,"live"),eventId:"invalid"}],completedScopes:["club","invalid"]}}))["2026-10-29"],{choices:[choice(1,"club")],completedScopes:["club"]});
const tap={x:2,y:3,velocity:0,width:358,maxDistance:4,dragging:false,photo:true};
assert.equal(getDiscoverGestureAction(tap),"open","A photo tap opens event details.");
assert.equal(getDiscoverGestureAction({...tap,photo:false}),"cancel","Tapping non-photo metadata does not open a photo action.");
assert.equal(getDiscoverGestureAction({...tap,x:140,maxDistance:140,dragging:true}),"like","A right swipe likes and never opens details.");
assert.equal(getDiscoverGestureAction({...tap,x:-140,maxDistance:140,dragging:true}),"skip","A left swipe skips and never opens details.");
assert.equal(getDiscoverGestureAction({...tap,x:2,maxDistance:45,dragging:true}),"cancel","Dragging away and back to the starting point must not become a tap.");
assert.equal(getDiscoverGestureAction({...tap,y:60,maxDistance:60}),"cancel","Vertical scrolling over a photo must not open details or save a like.");
assert.equal(getDiscoverGestureAction({...tap,x:90,y:300,maxDistance:313,dragging:true}),"cancel","A vertical scroll with lateral drift must not become a right swipe.");
assert.equal(getDiscoverGestureAction({...tap,cancelled:true}),"cancel");
const fullEvent={
  _id:id(8),date:"2026-06-17",title:"Večernji program",venue:"Test venue",artists:["Artist identity"],eventType:"nightlife",ticketPrice:"Free",time:"TBD",
  description:"Detaljan opis programa. ".repeat(500)+"Pozorišna predstava sa jazz i rock muzikom.",
  sourceCaption:"Originalni tekst objave. ".repeat(500),
  venueHours:{hoursJson:JSON.stringify({version:1,source:"manual",timezone:"Europe/Belgrade",generatedAt:"2026-06-17T12:00:00.000Z",weekly:[{day:3,closed:false,windows:[{day:3,start:"10:00",end:"18:00"},{day:3,start:"20:00",end:"02:00",spansNextDay:true}]}]})},
};
const projected=projectMobileDiscoverEvent(fullEvent);
assert.equal(projected.primaryCategory,"culture","Occurrence description still refines the coarse legacy type before projection.");
assert.equal(projected.primaryCategory,getEventPrimaryCategory(fullEvent));
assert.equal(getDiscoverCategory(projected),"culture","The browser uses the exact precomputed category without needing the large description.");
assert.equal(getDiscoverCategory({primaryCategory:"culture",eventType:"nightlife"}),"culture");
assert.deepEqual(projected.tags,getEventTags(fullEvent).filter(tag=>tag.toLowerCase()!=="besplatan ulaz").slice(0,2));
assert.deepEqual(projected.tags,["Rock","Jazz"],"Secondary tags retain their existing ordering/limit and omit the separate free-admission label.");
for(const time of ["TBD","21:00","21:00-23:30"]){
  assert.equal(projectMobileDiscoverEvent({...fullEvent,time}).timeLabel,resolveEventTimePresentation({...fullEvent,time}).label,"Venue-hours fallback, inferred closing and announced end retain the exact prior time presentation.");
}
assert.equal(projected.timeLabel,"10:00–18:00, 20:00–02:00");
assert.deepEqual(Object.keys(projected).sort(),["_id","date","primaryCategory","tags","ticketPrice","timeLabel","title","venue"].sort(),"Mobile hydration carries only display values and identity, never descriptions, artists, captions or hours JSON.");
assert.ok(JSON.stringify(projected).length<JSON.stringify(fullEvent).length/10,"Long source material must not dominate the mobile deck payload.");
console.log("QA passed: immediate Discover saves, isolated auth replay/retry, photo tap/swipe gestures, and lean mobile projection preserving category/tags/venue hours.");
