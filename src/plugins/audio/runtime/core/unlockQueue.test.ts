// A1.6 L1: the locked queue (D5). Skeleton: the leaf fills these in.
import { describe, it } from "vitest";

describe("UnlockQueue (D5)", () => {
  it.todo("a new queue is empty: size 0, oneShotCount 0, droppedCount 0");
  it.todo("drain starts every queued item once, in push order, and leaves the queue empty");
  it.todo("one-shots and owned items interleave in push order on drain");
  it.todo("32 one-shots queue; the 33rd drops the oldest one-shot (reason overflow) and the newest 32 stay");
  it.todo("a one-shot older than 1000 ms at the next push is dropped with reason expired");
  it.todo("a one-shot exactly 1000 ms old at drain is kept; 1001 ms old is dropped with reason expired and not started");
  it.todo("owned and looping items never expire and never count toward the 32");
  it.todo("owned items survive any number of one-shot overflows");
  it.todo("pushing 100 owned items then 40 one-shots keeps all 100 owned and the newest 32 one-shots");
  it.todo("custom maxOneShots and windowMs are honoured");
  it.todo("onDrop is called once per dropped item with the item and the reason; not for started items");
  it.todo("droppedCount counts overflow and expired drops, and not remove or clear");
  it.todo("remove takes a queued item out (true), a missing item gives false, and onDrop is not called");
  it.todo("clear empties the queue without calling onDrop or start");
  it.todo("an item pushed from inside the drain's start callback is not started by that drain");
  it.todo("drain on an empty queue is a no-op");
  it.todo("a second drain after the first starts nothing");
});
