import { describe, it, expect } from "vitest";
import {
  EntityStateMachine,
  canTransition,
  isTerminal,
  InvalidTransitionError,
} from "../../src/transfer/entityStateMachine.js";
import { EntityState } from "../../src/types/transfer.js";

describe("EntityStateMachine", () => {
  it("walks the full source path CREATED → COMPLETED", () => {
    const sm = new EntityStateMachine();
    const path = [
      EntityState.Selected,
      EntityState.Locked,
      EntityState.Held,
      EntityState.Validated,
      EntityState.Encrypted,
      EntityState.Queued,
      EntityState.Sending,
      EntityState.InTransit,
      EntityState.Completed,
    ];
    for (const s of path) expect(sm.tryTransition(s)).toBe(true);
    expect(sm.current).toBe(EntityState.Completed);
    expect(sm.terminal).toBe(true);
  });

  it("walks the destination path RECEIVED → COMPLETED", () => {
    const sm = new EntityStateMachine(EntityState.Received);
    for (const s of [EntityState.Decrypted, EntityState.Ready, EntityState.Dropped, EntityState.Completed]) {
      expect(sm.tryTransition(s)).toBe(true);
    }
  });

  it("allows HELD → DROPPED (put down without sending)", () => {
    expect(canTransition(EntityState.Held, EntityState.Dropped)).toBe(true);
  });

  it("rejects illegal jumps", () => {
    const sm = new EntityStateMachine();
    expect(sm.tryTransition(EntityState.Sending)).toBe(false);
    expect(() => sm.transition(EntityState.Completed)).toThrow(InvalidTransitionError);
  });

  it("allows FAIL from any active state but not from a terminal", () => {
    expect(canTransition(EntityState.Sending, EntityState.Failed)).toBe(true);
    expect(canTransition(EntityState.Completed, EntityState.Failed)).toBe(false);
    expect(isTerminal(EntityState.Failed)).toBe(true);
  });

  it("permits CANCEL early but not after sending starts", () => {
    expect(canTransition(EntityState.Held, EntityState.Cancelled)).toBe(true);
    expect(canTransition(EntityState.Sending, EntityState.Cancelled)).toBe(false);
  });
});
