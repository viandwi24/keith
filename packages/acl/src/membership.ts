/**
 * What the evaluator asks the world, at check time. Both answers are read from the database for
 * every check (or per call), never from a principal or a cache that outlives the call.
 */
export interface Membership {
  /** The person exists and is `active` (suspended, left and unknown are false). */
  isActive(personId: string): boolean
  /** The person is a member of the group (a group that does not exist has no members). */
  isMember(groupId: string, personId: string): boolean
}
