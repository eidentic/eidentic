import { describe, it, expectTypeOf } from "vitest";
import { chain, step, agentStep } from "@eidentic/workflow";
import type { Step } from "@eidentic/workflow";

// ─── Type-level proof for the variadic `chain` signature ──────────────────────
//
// These assertions are checked by `tsc` (the DTS build) and by
// `vitest --typecheck`. They prove unlimited-length inference, exact
// first-in / last-out, mixed step wrappers, and compile-time adjacency checking.

const numToStr: Step<number, string> = async (n) => String(n);
const strToNum: Step<string, number> = async (s) => s.length;
const strToBool: Step<string, boolean> = async (s) => s.length > 0;
const numToBool: Step<number, boolean> = async (n) => n > 0;
const double: Step<number, number> = async (n) => n * 2;
const add1: Step<number, number> = async (n) => n + 1;

describe("chain() — type inference", () => {
  it("empty chain → Step<unknown, never>", () => {
    const result = chain();
    expectTypeOf(result).toEqualTypeOf<Step<unknown, never>>();
  });

  it("single-step chain infers that step's exact type", () => {
    const result = chain(numToStr);
    expectTypeOf(result).toEqualTypeOf<Step<number, string>>();
  });

  it("two-step chain infers Step<first-in, last-out>", () => {
    const result = chain(numToStr, strToBool);
    expectTypeOf(result).toEqualTypeOf<Step<number, boolean>>();
  });

  it("3-step chain infers exactly", () => {
    const result = chain(numToStr, strToNum, double);
    expectTypeOf(result).toEqualTypeOf<Step<number, number>>();
  });

  it("6-step chain infers Step<first-in, last-out> exactly", () => {
    // number → string → number → number → number → string → number
    const result = chain(numToStr, strToNum, double, add1, numToStr, strToNum);
    expectTypeOf(result).toEqualTypeOf<Step<number, number>>();
  });

  it("12-step chain infers Step<T0, T12> exactly (no 8-step cap, no unknown)", () => {
    // 13 distinct branded types so an off-by-one or `unknown` collapse fails.
    type T0 = { _0: 1 }; type T1 = { _1: 1 }; type T2 = { _2: 1 }; type T3 = { _3: 1 };
    type T4 = { _4: 1 }; type T5 = { _5: 1 }; type T6 = { _6: 1 }; type T7 = { _7: 1 };
    type T8 = { _8: 1 }; type T9 = { _9: 1 }; type T10 = { _10: 1 }; type T11 = { _11: 1 };
    type T12 = { _12: 1 };
    const s = <A, B>(): Step<A, B> => async () => undefined as B;
    const result = chain(
      s<T0, T1>(), s<T1, T2>(), s<T2, T3>(), s<T3, T4>(),
      s<T4, T5>(), s<T5, T6>(), s<T6, T7>(), s<T7, T8>(),
      s<T8, T9>(), s<T9, T10>(), s<T10, T11>(), s<T11, T12>(),
    );
    expectTypeOf(result).toEqualTypeOf<Step<T0, T12>>();
    // Exactness guards: first-in is T0 (not unknown), last-out is T12 (not unknown).
    expectTypeOf(result).parameter(0).toEqualTypeOf<T0>();
    expectTypeOf(result).returns.resolves.toEqualTypeOf<T12>();
  });

  it("20-step chain still infers exactly (recursion ceiling well clear)", () => {
    const s = <A, B>(): Step<A, B> => async () => undefined as B;
    type N0 = { n: 0 }; type N20 = { n: 20 };
    const result = chain(
      s<N0, { n: 1 }>(), s<{ n: 1 }, { n: 2 }>(), s<{ n: 2 }, { n: 3 }>(),
      s<{ n: 3 }, { n: 4 }>(), s<{ n: 4 }, { n: 5 }>(), s<{ n: 5 }, { n: 6 }>(),
      s<{ n: 6 }, { n: 7 }>(), s<{ n: 7 }, { n: 8 }>(), s<{ n: 8 }, { n: 9 }>(),
      s<{ n: 9 }, { n: 10 }>(), s<{ n: 10 }, { n: 11 }>(), s<{ n: 11 }, { n: 12 }>(),
      s<{ n: 12 }, { n: 13 }>(), s<{ n: 13 }, { n: 14 }>(), s<{ n: 14 }, { n: 15 }>(),
      s<{ n: 15 }, { n: 16 }>(), s<{ n: 16 }, { n: 17 }>(), s<{ n: 17 }, { n: 18 }>(),
      s<{ n: 18 }, { n: 19 }>(), s<{ n: 19 }, N20>(),
    );
    expectTypeOf(result).toEqualTypeOf<Step<N0, N20>>();
  });

  it("infers across step()/agentStep()-wrapped steps", () => {
    // step() preserves Step<I,O>.
    const wrappedNumToStr = step("toStr", numToStr); // Step<number,string>
    const result = chain(wrappedNumToStr, strToNum, double);
    expectTypeOf(result).toEqualTypeOf<Step<number, number>>();

    // agentStep<I,O> yields Step<I,O> and composes with downstream steps.
    const ag = agentStep<string, number>({} as never);
    const mixed = chain(numToStr, ag, double);
    expectTypeOf(mixed).toEqualTypeOf<Step<number, number>>();
  });

  it("rejects a mismatched adjacency at compile time", () => {
    // numToStr outputs `string`; numToBool expects `number`. The 2nd argument
    // therefore fails its computed `Step<string, …>` constraint.
    // @ts-expect-error step output `string` is not assignable to next input `number`
    chain(numToStr, numToBool);

    // Sanity: a *correct* link with the same shapes must still compile.
    chain(numToStr, strToBool);
  });

  it("rejects a mismatch deep in a long chain at compile time", () => {
    // Break the link at step 4: double outputs `number`, but strToNum expects
    // `string`. The error surfaces at the offending argument.
    // @ts-expect-error broken adjacency mid-chain
    chain(numToStr, strToNum, double, strToNum, numToBool);
  });
});
