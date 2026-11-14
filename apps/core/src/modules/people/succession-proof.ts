// The proof that an heir's claim is allowed (docs/specs/succession.md, "The claim"). `PeopleService.succeed` takes one, so
// a caller cannot change the owner through the succession path without the succession module's checks having run. The
// brand is a type-only symbol: at run time the proof is an empty object, and only `modules/hypothalamus/succession.ts`
// calls `mintSuccessionProof` (a test pins that). No RPC procedure or CLI command reaches `succeed`.
declare const successionProofBrand: unique symbol

export type SuccessionProof = { readonly [successionProofBrand]: 'succession' }

/** Minted only after the succession checks (state, grace, step-up, last sign) pass. */
export function mintSuccessionProof(): SuccessionProof {
  return {} as SuccessionProof
}
