let cl = console.log;

function debugLog(...messages) {
  // isDevMode is set in webview.ts
  if (isDevMode) {
    messages.forEach(msg => console.log(msg));
  }
}

export class Loop {
  constructor(startOffset, endOffset, startLineno) {
    this.startLineno = startLineno;
    this.startOffset = startOffset;
    this.endOffset = endOffset;
    this.counter = 0;
    this.parent = undefined;
    this.children = new Set();
    this.id = `loop@line${startLineno}`;

    // Note that the number of iterations != maxCounter
    //
    // for i in range(2):
    //   for j in range(2):
    //
    // For the inner loop, number of iterations is 4, but maxCounter is 1.
    this.maxCounter = 0;

    // The index of the first event in each iteration of this loop.
    // Maps counter to index. Note that the counter includes parent's counter, like [0,0,1]
    this._iterationStarts = new Map();
  }

  incrementCounter() {
    this.counter++;
    this.maxCounter = Math.max(this.counter, this.maxCounter);
  }

  addIterationStart(counters, eventIndex) {
    // We can't use array as keys directly, since we don't keep the array objects.
    this._iterationStarts.set(counters.toString(), eventIndex);
  }

  getCurrentIterationStart() {
    return this._iterationStarts.get(this.getCounters().toString());
  }

  /* Calculates the counters array from top-level loop to the modified loop.
   *  Outer loop's counter will precedes inner loops'.
   */
  getCounters() {
    let counters = [this.counter];
    let parentLoop = this.parent;
    while (parentLoop !== undefined) {
      counters.unshift(parentLoop.counter);
      parentLoop = parentLoop.parent;
    }
    return counters;
  }

  /*

  Parameters:
    events: a sequence of events in one frame, sorted by the order they occurred.
    visibleEvents: currently visible events, does it need to be sorted?
    loop: a loop whose counter is modified.

  Returns:
    item 1: nodes to hide
    item 2: nodes to show

   */
  generateNodeUpdate(events, visibleEvents) {
    // Maps offset to events.
    let eventsToHide = new Map();
    let eventsToShow = new Map();

    // Calculates events that should be hidden.
    for (let visibleEvent of visibleEvents) {
      if (visibleEvent.offset < this.startOffset) {
        continue;
      }
      if (visibleEvent.offset > this.endOffset) {
        break;
      }
      eventsToHide.set(visibleEvent.offset, visibleEvent);
    }

    // Calculates events that should be made visible, in this loop.
    let maxReachedOffset = -1;
    for (let i = this.getCurrentIterationStart(); i < events.length; i++) {
      let event = events[i];
      let offset = event.offset;
      if (offset > this.endOffset) {
        break;
      }
      if (offset > maxReachedOffset) {
        maxReachedOffset = offset;
        if (
          !eventsToShow.has(event.offset) &&
          event.type !== "JumpBackToLoopStart"
        ) {
          // Only set once (target iteration), don't let later iterations override the result.
          eventsToShow.set(event.offset, event);
        }
      }
    }

    // Calculates events that should be made visible in inner loops if any.
    for (let innerLoop of this.children) {
      const [_, eventsToShowFromInner] = innerLoop.generateNodeUpdate(
        events,
        visibleEvents
      );
      // Merge and let results from inner loops override outer loops
      eventsToShow = new Map([...eventsToShow, ...eventsToShowFromInner]);
    }

    return [eventsToHide, eventsToShow];
  }
}

/*
Class that
- Manage raw events and loops, including loops' state.
- Calculates the currently visible events.

 */
export class TraceData {
  /* Initialize the trace graph.

  Parameters:
    events: a sequence of events in one frame, sorted by the order they occurred.
    loops: a array of loops, sorted by loop start offset.

  Returns:
    - A list of events that should be displayed in the trace graph initially.
    - Updated loops.
    - A mapping from a lineno to its rank among all appeared linen numbers.
      For example, appeared line numbers are 2, 3, 5
      returned mapping is {2 => 1, 3 => 2, 5 => 3}

  Updates:
    The passed in loops, whose iterations are detected and recorded.

   */
  initialize(events, loops) {
    let loopStack = [];
    let maxReachedOffset = -1;
    let visibleEvents = [];
    let previousEventOffset = -2;
    let appearedLineNumbers = new Set();

    for (let event of events) {
      let offset = event.offset;
      appearedLineNumbers.add(event.lineno);

      // For initial state, all loop counters are 0, thus visible events should form a
      // sequence in which the next event always has a larger offset than the previous one.
      //
      // Note that we use >= instead of >. This is because we may need to two nodes of the
      // same offset. e.g.
      //
      //    nonlocal a
      //    a = 1
      //
      // In this case, the initial value event and binding event has the same offset because
      // they are both triggered by the STORE_DEREF instruction.
      if (offset >= maxReachedOffset) {
        maxReachedOffset = offset;

        // Don't include JumpBackToLoopStart in visible events.
        if (event.type !== "JumpBackToLoopStart") {
          visibleEvents.push(event);
        }
      }

      // Pops loop out of the stack.
      if (
        loopStack.length > 0 &&
        loopStack[loopStack.length - 1].endOffset < offset
      ) {
        loopStack.pop().counter = 0;
      }

      let currentLoop = loopStack[loopStack.length - 1];
      let nextEventIndex = event.index + 1;

      if (
        event.type === "JumpBackToLoopStart" &&
        event.index < events.length - 1 &&
        events[nextEventIndex].offset < offset
      ) {
        currentLoop.incrementCounter();
        currentLoop.addIterationStart(
          loopStack.map(loop => loop.counter),
          nextEventIndex // The event following JumpBackToLoopStart is next iteration's start.
        );
      }

      // Pushes loop onto the stack.
      for (let loop of loops) {
        if (
          previousEventOffset < loop.startOffset &&
          loop.startOffset <= offset
        ) {
          if (loopStack.length > 0 && loop.parent === undefined) {
            currentLoop.children.add(loop);
            loop.parent = currentLoop;
          }
          loopStack.push(loop);
          loop.addIterationStart(
            loopStack.map(loop => loop.counter),
            event.index
          );
        }
      }
      previousEventOffset = offset;
    }

    // Restores to the initial state.
    for (let loop of loops) {
      loop.counter = 0;
    }

    // There's space from improvements for building linenoMapping.
    //
    // The easiest one being, if line range is small, just use the original lineno as rank.
    //
    // Another idea is to recalculate distance and make them smaller.
    // for example, distance [1, 2] becomes 1, [3, 5] becomes 2, > 5 becomes 3.
    let linenoMapping = new Map();
    Array.from(appearedLineNumbers)
      .sort((a, b) => a - b)
      .forEach((lineno, ranking) => {
        linenoMapping.set(lineno, ranking + 1); // Level starts with 1, leaving level 0 to InitialValue nodes
      });

    return [visibleEvents, loops, linenoMapping];
  }
}