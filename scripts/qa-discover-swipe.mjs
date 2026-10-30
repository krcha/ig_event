import assert from "node:assert/strict";
import {
  choicesForScope, completedDiscoverLikes, getDiscoverCategory, markDiscoverCompletion,
  pendingDiscoverSaveIds, readDiscoverSessions, recordDiscoverChoice, restartDiscoverScope, undoDiscoverChoice,
  acknowledgeDiscoverSaves, discoverSessionStorageKey, mergeGuestDiscoverSessions,
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
assert.deepEqual(completedDiscoverLikes({"2026-10-29":day}),[],"An unfinished guest session must not trigger saving.");
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
console.log("QA passed: Discover swipe preserves filter/day choices, normalizes social, completes nonempty scopes, replays guest likes, and retries confirmed-safe saves.");
