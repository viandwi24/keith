import { oc } from '@orpc/contract'
import { z } from 'zod'
import {
  AclChgrpSchema,
  AclChmodSchema,
  AclChownSchema,
  AclShareSchema,
  AclUnshareSchema,
  AclViewSchema,
  AuditRetentionSchema,
  AuditRetentionSetSchema,
  GroupCreateSchema,
  GroupMemberInputSchema,
  GroupRefSchema,
  GroupViewSchema,
  ResourceRefSchema,
} from './acl-admin.ts'
import {
  LogsCallInputSchema,
  LogsCallOutputSchema,
  LogsPurgeInputSchema,
  LogsPurgeOutputSchema,
  LogsRawInputSchema,
  LogsRawOutputSchema,
  LogsSessionInputSchema,
  LogsSessionOutputSchema,
  LogsSessionsInputSchema,
  LogsSessionsOutputSchema,
  LogsSettingsSchema,
  LogsSettingsSetSchema,
  LogsStatusSchema,
} from './activity-logs.ts'
import {
  AccessSchema,
  AccessSetSchema,
  AuditEventSchema,
  DeviceApprovedSchema,
  DeviceApproveInputSchema,
  DeviceListSchema,
  SessionInfoSchema,
  TokenCreatedSchema,
  TokenInfoSchema,
  WhoamiSchema,
} from './admin.ts'
import { ApprovalsSchema, ApprovalsSetSchema } from './approvals.ts'
import { AuditMineInputSchema, AuditNoticeSchema, MyAuditEventSchema } from './audit.ts'
import { AuthPolicyInputSchema, AuthPolicyViewSchema } from './auth-flow.ts'
import {
  BudgetCapSetSchema,
  BudgetPersonSchema,
  BudgetSetSchema,
  BudgetStatusSchema,
} from './budget.ts'
import {
  type Capability,
  CapabilityGrantSchema,
  PersonCapabilitySchema,
  type ProcedureMeta,
} from './capabilities.ts'
import {
  ChatCompactInputSchema,
  ChatCompactOutputSchema,
  ChatGenerationsOutputSchema,
  ChatHistoryInputSchema,
  ChatHistoryOutputSchema,
  ChatNewContextInputSchema,
  ChatNewContextOutputSchema,
} from './chat-context.ts'
import { AdminNoticeSendSchema, AdminNoticeSentSchema } from './delivery.ts'
import {
  DreamApplyInputSchema,
  DreamDiaryInputSchema,
  DreamDiaryOutputSchema,
  DreamingSettingsSchema,
  DreamingSettingsSetSchema,
  DreamModeInputSchema,
  DreamRunViewSchema,
  DreamStatusViewSchema,
  DreamUndoInputSchema,
  DreamUndoOutputSchema,
} from './dreaming.ts'
import {
  GuestEndedSchema,
  GuestKillSchema,
  GuestPeekSchema,
  GuestSessionInfoSchema,
  GuestSessionRefSchema,
  GuestSettingsPatchSchema,
  GuestStatusSchema,
} from './guests.ts'
import { HealthSchema } from './health.ts'
import {
  LocalAccessGetSchema,
  LocalAccessSetSchema,
  LocalAccessViewSchema,
} from './local-access.ts'
import {
  ModelPriceClearSchema,
  ModelPriceSchema,
  ModelRefSchema,
  ModelRoleSchema,
  ModelRolesSchema,
} from './models.ts'
import { NodeSchema, NodeSettingsSchema, PairingCodeSchema } from './nodes.ts'
import {
  OwnerTransferredSchema,
  PeopleSetLoginInputSchema,
  PersonAddSchema,
  PersonAliasAddSchema,
  PersonAliasRemoveSchema,
  PersonAliasSchema,
  PersonClearSecretSchema,
  PersonExportedSchema,
  PersonExportSchema,
  PersonRefSchema,
  PersonRemovedSchema,
  PersonRenameSchema,
  PersonSchema,
  PersonSetPasswordSchema,
  PersonSetPinSchema,
  PersonSetRoleSchema,
  PersonUnlockResultSchema,
} from './people.ts'
import {
  PersonaEditInputSchema,
  PersonaRestoreInputSchema,
  PersonaSetTemplateInputSchema,
  PersonaStyleReadInputSchema,
  PersonaStyleSetInputSchema,
  PersonaVersionSchema,
  PersonaViewSchema,
  PersonStyleSchema,
} from './persona.ts'
import {
  CapabilityInfoSchema,
  OpenViewSchema,
  PluginDetailSchema,
  PluginInfoSchema,
  PluginRefSchema,
  PluginToggleSchema,
} from './plugins-admin.ts'
import {
  ClientAckSchema,
  ClientHeartbeatSchema,
  ClientRecordSchema,
  ClientRefSchema,
  ClientRegisterSchema,
  DisclosureRowSchema,
  DisclosureSetSchema,
  PresenceMineSchema,
  PresenceRawInputSchema,
  PresenceRawSchema,
  PresenceStatusSetSchema,
  PresenceStatusViewSchema,
} from './presence.ts'
import {
  AgendaAddInputSchema,
  AgendaItemSchema,
  AgendaListInputSchema,
  AgendaListOutputSchema,
  AgendaRefSchema,
  ProtocolAnswerInputSchema,
  ProtocolAnswerOutputSchema,
  ProtocolListOutputSchema,
  ProtocolPauseInputSchema,
  ProtocolProposalRefSchema,
  ProtocolProposalsOutputSchema,
  ProtocolRefSchema,
  ProtocolRunsInputSchema,
  ProtocolRunsOutputSchema,
  ProtocolSaveInputSchema,
  ProtocolSetEnabledInputSchema,
  ProtocolSettingsSchema,
  ProtocolSettingsSetSchema,
  ProtocolViewSchema,
} from './protocols.ts'
import {
  ConnectionInputSchema,
  ConnectionSchema,
  ModelSchema,
  ProviderDescriptionSchema,
  TestResultSchema,
} from './providers.ts'
import {
  PushPreviewSchema,
  PushPublicKeySchema,
  PushRecordSchema,
  PushSubscribeSchema,
  PushUnsubscribeSchema,
} from './push.ts'
import {
  ReviewDenyInputSchema,
  ReviewListInputSchema,
  ReviewRefSchema,
  ReviewViewSchema,
} from './reviews.ts'
import {
  RoomSettingsSchema,
  RoomSettingsSetSchema,
  RoomsAcceptInputSchema,
  RoomsConfirmInputSchema,
  RoomsConfirmOutputSchema,
  RoomsDeclineInputSchema,
  RoomsEndInputSchema,
  RoomsEventsInputSchema,
  RoomsEventsOutputSchema,
  RoomsFilesInputSchema,
  RoomsFilesOutputSchema,
  RoomsGetInputSchema,
  RoomsInviteInputSchema,
  RoomsLeaveInputSchema,
  RoomsListInputSchema,
  RoomsListOutputSchema,
  RoomsOkSchema,
  RoomsRemoveInputSchema,
  RoomsSayInputSchema,
  RoomsSayOutputSchema,
  RoomsStartInputSchema,
  RoomViewSchema,
} from './rooms.ts'
import {
  SuccessionClaimInputSchema,
  SuccessionClaimOutputSchema,
  SuccessionOwnerViewSchema,
  SuccessionPauseInputSchema,
  SuccessionSetHeirInputSchema,
  SuccessionSetWindowInputSchema,
  SuccessionViewSchema,
} from './succession.ts'
import { TaskSchema } from './tasks.ts'

const ConnectionId = z.object({ id: z.string() })

/**
 * Every procedure starts from `can(...)`: the capability it needs and whether a remote caller must
 * have stepped up first. A test fails when a procedure has none (docs/specs/permissions.md).
 */
const base = oc.$meta<Partial<ProcedureMeta>>({})
const can = (capability: Capability | 'authenticated', stepUp = false) =>
  base.meta(stepUp ? { capability, stepUp: true } : { capability })
/** Same, for a call that changes something sensitive: remote callers need a step-up. */
const sensitive = (capability: Capability) => can(capability, true)

/** The Keith API besides chat (chat is `eharness/http` under `/sessions`, ADR-0003). */
export const keithContract = {
  health: {
    get: can('authenticated').output(HealthSchema),
  },
  providers: {
    describe: can('settings.read').output(z.array(ProviderDescriptionSchema)),
    list: can('settings.manage').output(z.array(ConnectionSchema)),
    put: sensitive('settings.manage').input(ConnectionInputSchema).output(ConnectionSchema),
    remove: sensitive('settings.manage')
      .input(ConnectionId)
      .output(z.object({ ok: z.literal(true) })),
    test: can('settings.manage').input(ConnectionId).output(TestResultSchema),
    models: can('settings.read')
      .input(ConnectionId.extend({ refresh: z.boolean().optional() }))
      .output(z.array(ModelSchema)),
  },
  tasks: {
    list: can('tasks.own')
      .input(
        z.object({
          active: z.boolean().optional(),
          limit: z.number().int().min(1).max(200).optional(),
        }),
      )
      .output(z.array(TaskSchema)),
    stop: can('tasks.own')
      .input(z.object({ id: z.string() }))
      .output(z.object({ ok: z.literal(true) })),
  },
  nodes: {
    list: can('nodes.read').output(z.array(NodeSchema)),
    pair: sensitive('nodes.manage').output(PairingCodeSchema),
    revoke: sensitive('nodes.manage')
      .input(z.object({ id: z.string() }))
      .output(z.object({ ok: z.literal(true) })),
    /** The calls per hour one person may make to a capability that runs without asking (node-drivers.md "Settings"): owner, step-up. */
    settings: {
      get: can('settings.read').output(NodeSettingsSchema),
      set: sensitive('settings.manage').input(NodeSettingsSchema).output(NodeSettingsSchema),
    },
  },
  /**
   * Presence and clients of the signed-in person (docs/specs/parietal.md). Every signed-in person (`chat`): a person
   * changes their own presence, and the service refuses a client id of another person. A guest has no person.
   */
  presence: {
    clients: {
      register: can('chat').input(ClientRegisterSchema).output(ClientRecordSchema),
      heartbeat: can('chat')
        .input(ClientHeartbeatSchema)
        .output(z.object({ ok: z.literal(true) })),
      goodbye: can('chat')
        .input(ClientRefSchema)
        .output(z.object({ ok: z.literal(true) })),
      /** A client's answer to a `brain.parietal.deliver` record (`callClient`, P27.5.1). */
      ack: can('chat')
        .input(ClientAckSchema)
        .output(z.object({ ok: z.literal(true) })),
      list: can('chat').output(z.array(ClientRecordSchema)),
      remove: can('chat')
        .input(ClientRefSchema)
        .output(z.object({ ok: z.literal(true) })),
    },
    /** The caller's own presence, clients, manual status and disclosure settings. */
    mine: can('chat').output(PresenceMineSchema),
    /** Busy (with a note and an end) or free (`busy: false`). */
    setStatus: can('chat').input(PresenceStatusSetSchema).output(PresenceStatusViewSchema),
    disclosure: {
      set: can('chat').input(DisclosureSetSchema).output(DisclosureRowSchema),
    },
    /** Web Push of the signed-in person (docs/specs/push.md, ADR-0035): every call is the caller's own. */
    push: {
      /** The VAPID public key, base64url: the `applicationServerKey` of `pushManager.subscribe`. */
      publicKey: can('authenticated').output(PushPublicKeySchema),
      subscribe: can('authenticated').input(PushSubscribeSchema).output(PushRecordSchema),
      unsubscribe: can('authenticated')
        .input(PushUnsubscribeSchema)
        .output(z.object({ ok: z.literal(true) })),
      list: can('authenticated').output(z.array(PushRecordSchema)),
      /** The setting `push.preview`: whether a push carries the message text (default off). */
      preview: {
        get: can('authenticated').output(PushPreviewSchema),
        set: can('authenticated').input(PushPreviewSchema).output(PushPreviewSchema),
      },
    },
  },
  budget: {
    get: can('budget.read').output(BudgetStatusSchema),
    set: sensitive('budget.manage').input(BudgetSetSchema).output(BudgetStatusSchema),
    setPersonCap: sensitive('budget.manage').input(BudgetCapSetSchema).output(BudgetPersonSchema),
  },
  auth: {
    /** Who this call is: person, role, listener and credential kind (any signed-in principal). */
    whoami: can('authenticated').output(WhoamiSchema),
    /** Revoke the credential this call is made with (any signed-in principal; no-op on the socket). */
    logout: can('authenticated').output(z.object({ ok: z.literal(true) })),
    /** The caller's own PIN (6-12 digits). A remote caller needs a step-up, which a PIN session cannot have. */
    pin: {
      set: can('authenticated', true)
        .input(z.object({ pin: z.string().min(1).max(64) }))
        .output(z.object({ ok: z.literal(true) })),
    },
    /** The caller's own live sessions; ending another one from a remote client needs a step-up. */
    sessions: {
      list: can('authenticated').output(z.array(SessionInfoSchema)),
      revoke: can('authenticated')
        .input(z.object({ id: z.string() }))
        .output(z.object({ ok: z.literal(true) })),
    },
  },
  admin: {
    /**
     * The raw presence record of one person: the owner's console (`keith-core presence`). Owner only (`audit.read`,
     * never granted to a member); audited as `presence.read` (docs/specs/parietal.md).
     */
    presence: {
      read: can('audit.read').input(PresenceRawInputSchema).output(PresenceRawSchema),
    },
    /**
     * The owner's test notice (`keith-core notify`): one delivery with `notify` through the real delivery path. Owner only
     * (`audit.read`, as the presence read; a remote owner steps up); audited as `delivery.test_notice` without the text.
     */
    notice: {
      send: sensitive('audit.read').input(AdminNoticeSendSchema).output(AdminNoticeSentSchema),
    },
    audit: {
      list: can('audit.read')
        .input(z.object({ limit: z.number().int().min(1).max(500).optional() }))
        .output(z.array(AuditEventSchema)),
      /**
       * The lines about the caller: who looked at or changed something of theirs (every person; ADR-0027 §6). The
       * owner may name another person to show them their lines.
       */
      mine: can('audit.mine').input(AuditMineInputSchema).output(z.array(MyAuditEventSchema)),
      /**
       * The first-login notice ("how this Keith treats your things"): `get` says whether this person has seen it, `ack`
       * records that they did (once: a second `ack`, from any device, writes nothing). Every signed-in person.
       */
      notice: {
        get: can('authenticated').output(AuditNoticeSchema),
        ack: can('authenticated').output(z.object({ ok: z.literal(true) })),
      },
      /** How long the audit log is kept (owner only, step-up to change; 0 keeps everything). */
      retention: {
        get: can('audit.read').output(AuditRetentionSchema),
        set: sensitive('settings.manage')
          .input(AuditRetentionSetSchema)
          .output(AuditRetentionSchema),
      },
    },
    /**
     * How long a pending approval waits for an answer (ADR-0027 §10). Anyone may read it; setting it is
     * `settings.manage` with a step-up from a remote caller. An older request is denied as `expired`.
     */
    approvals: {
      get: can('settings.read').output(ApprovalsSchema),
      set: sensitive('settings.manage').input(ApprovalsSetSchema).output(ApprovalsSchema),
    },
    /** Groups of people for sharing (ADR-0015). Owner only: `groups.manage` is never granted to a member. */
    groups: {
      list: can('groups.manage').output(z.array(GroupViewSchema)),
      get: can('groups.manage').input(GroupRefSchema).output(GroupViewSchema),
      create: sensitive('groups.manage').input(GroupCreateSchema).output(GroupViewSchema),
      delete: sensitive('groups.manage')
        .input(GroupRefSchema)
        .output(z.object({ ok: z.literal(true) })),
      add: sensitive('groups.manage').input(GroupMemberInputSchema).output(GroupViewSchema),
      remove: sensitive('groups.manage').input(GroupMemberInputSchema).output(GroupViewSchema),
    },
    /**
     * The heir and the succession window (docs/specs/succession.md, ADR-0022 §3). Every change is owner only
     * (`succession.manage`, refused to a delegate) with a step-up. `get` is decided in the handler: the owner sees
     * the owner view, the heir the heir view, anyone else `NOT_FOUND`. `claim` is the heir's own call: a credential
     * session (never the local socket), after the grace, with a step-up; the handler checks the rest.
     */
    succession: {
      get: can('authenticated').output(SuccessionViewSchema),
      setHeir: sensitive('succession.manage')
        .input(SuccessionSetHeirInputSchema)
        .output(SuccessionOwnerViewSchema),
      clearHeir: sensitive('succession.manage').output(SuccessionOwnerViewSchema),
      setWindow: sensitive('succession.manage')
        .input(SuccessionSetWindowInputSchema)
        .output(SuccessionOwnerViewSchema),
      pause: sensitive('succession.manage')
        .input(SuccessionPauseInputSchema)
        .output(SuccessionOwnerViewSchema),
      resume: sensitive('succession.manage').output(SuccessionOwnerViewSchema),
      claim: can('authenticated', true)
        .input(SuccessionClaimInputSchema)
        .output(SuccessionClaimOutputSchema),
    },
    /**
     * Operations plugins hold for the owner (P16, `plugins.md`). Owner only (`reviews.decide`); approving or denying
     * from a remote client needs a step-up. Approving runs the operation as the requester, revalidated now.
     */
    reviews: {
      list: can('reviews.decide').input(ReviewListInputSchema).output(z.array(ReviewViewSchema)),
      approve: sensitive('reviews.decide').input(ReviewRefSchema).output(ReviewViewSchema),
      deny: sensitive('reviews.decide').input(ReviewDenyInputSchema).output(ReviewViewSchema),
    },
    /**
     * The plugin layer for the operator (P16, `plugins.md`). Owner only (`plugins.manage`). Enable and disable save
     * the setting and apply at the next boot; they are `sensitive`.
     */
    plugins: {
      list: can('plugins.manage').output(z.array(PluginInfoSchema)),
      /** The plugin terminal views open now (ids and times; `keith-core doctor`). */
      views: { list: can('plugins.manage').output(z.array(OpenViewSchema)) },
      show: can('plugins.manage').input(PluginRefSchema).output(PluginDetailSchema),
      enable: sensitive('plugins.manage').input(PluginRefSchema).output(PluginToggleSchema),
      disable: sensitive('plugins.manage').input(PluginRefSchema).output(PluginToggleSchema),
    },
    /**
     * Guest mode (P17, `guests.md`): anonymous, incognito visitors. Owner only (`guests.manage`); everything that
     * changes something is `sensitive` and audited. Enabling is refused until a priced `guest` model is picked.
     */
    guests: {
      get: can('guests.manage').output(GuestStatusSchema),
      set: sensitive('guests.manage').input(GuestSettingsPatchSchema).output(GuestStatusSchema),
      killswitch: sensitive('guests.manage').input(GuestKillSchema).output(GuestEndedSchema),
      list: can('guests.manage').output(z.array(GuestSessionInfoSchema)),
      end: sensitive('guests.manage').input(GuestSessionRefSchema).output(GuestEndedSchema),
      /** The live transcript of one session. The visitor is told that an owner can watch (the banner). Audited as `guest.peek`. */
      peek: sensitive('guests.manage').input(GuestSessionRefSchema).output(GuestPeekSchema),
    },
    /** Every capability a person can hold now: the core ids and those of loaded plugins (the grant picker). */
    capabilities: {
      list: can('people.manage').output(z.array(CapabilityInfoSchema)),
    },
    /** The sign-in policy (ADR-0014). Owner only: the handler refuses anyone else, even with `settings.manage` granted. */
    auth: {
      policy: {
        get: can('settings.manage').output(AuthPolicyViewSchema),
        set: sensitive('settings.manage').input(AuthPolicyInputSchema).output(AuthPolicyViewSchema),
      },
      /** The local socket's idle-lock (owner only, like the policy). */
      local: {
        get: can('settings.manage').input(LocalAccessGetSchema).output(LocalAccessViewSchema),
        set: sensitive('settings.manage').input(LocalAccessSetSchema).output(LocalAccessViewSchema),
      },
    },
    /** Live sessions of any person (the owner's view); `person` omitted = the caller. */
    sessions: {
      list: can('people.manage')
        .input(z.object({ person: z.string().min(1).max(100).optional() }))
        .output(z.array(SessionInfoSchema)),
      revoke: sensitive('people.manage')
        .input(z.object({ id: z.string() }))
        .output(z.object({ ok: z.literal(true) })),
    },
    devices: {
      list: can('devices.manage').output(DeviceListSchema),
      approve: sensitive('devices.manage')
        .input(DeviceApproveInputSchema)
        .output(DeviceApprovedSchema),
      deny: sensitive('devices.manage')
        .input(z.object({ code: z.string().min(1).max(40) }))
        .output(z.object({ ok: z.literal(true) })),
      revoke: sensitive('devices.manage')
        .input(z.object({ id: z.string() }))
        .output(z.object({ ok: z.literal(true) })),
    },
    access: {
      get: can('settings.manage').output(AccessSchema),
      set: sensitive('settings.manage').input(AccessSetSchema).output(AccessSchema),
    },
    /** People: `people.manage`; every call that changes something needs a step-up from a remote caller. */
    people: {
      list: can('people.manage').output(z.array(PersonSchema)),
      get: can('people.manage').input(PersonRefSchema).output(PersonSchema),
      add: sensitive('people.manage').input(PersonAddSchema).output(PersonSchema),
      rename: sensitive('people.manage').input(PersonRenameSchema).output(PersonSchema),
      setRole: sensitive('people.manage').input(PersonSetRoleSchema).output(PersonSchema),
      suspend: sensitive('people.manage').input(PersonRefSchema).output(PersonSchema),
      reactivate: sensitive('people.manage').input(PersonRefSchema).output(PersonSchema),
      remove: sensitive('people.manage').input(PersonRefSchema).output(PersonRemovedSchema),
      /** Owner only (the service refuses a delegate): an archive of a person's data, ADR-0027 §26. */
      export: sensitive('people.manage').input(PersonExportSchema).output(PersonExportedSchema),
      transferOwner: sensitive('people.manage')
        .input(PersonRefSchema)
        .output(OwnerTransferredSchema),
      setPassword: sensitive('people.manage')
        .input(PersonSetPasswordSchema)
        .output(z.object({ ok: z.literal(true) })),
      setPin: sensitive('people.manage')
        .input(PersonSetPinSchema)
        .output(z.object({ ok: z.literal(true) })),
      clearSecret: sensitive('people.manage')
        .input(PersonClearSecretSchema)
        .output(z.object({ ok: z.literal(true) })),
      unlock: sensitive('people.manage').input(PersonRefSchema).output(PersonUnlockResultSchema),
      /** Owner only: the service refuses a delegate (ADR-0027 §27). Off ends the person's sessions. */
      setLogin: sensitive('people.manage').input(PeopleSetLoginInputSchema).output(PersonSchema),
      /** Email and phone aliases a person may sign in with (ADR-0014). */
      alias: {
        list: can('people.manage').input(PersonRefSchema).output(z.array(PersonAliasSchema)),
        add: sensitive('people.manage').input(PersonAliasAddSchema).output(PersonAliasSchema),
        remove: sensitive('people.manage')
          .input(PersonAliasRemoveSchema)
          .output(z.object({ ok: z.literal(true) })),
      },
      /** The capabilities granted to a person on top of their role. */
      grants: can('people.manage').input(PersonRefSchema).output(z.array(PersonCapabilitySchema)),
      grant: sensitive('people.manage')
        .input(CapabilityGrantSchema)
        .output(z.array(PersonCapabilitySchema)),
      revokeGrant: sensitive('people.manage')
        .input(CapabilityGrantSchema)
        .output(z.array(PersonCapabilitySchema)),
    },
    tokens: {
      list: can('tokens.manage').output(z.array(TokenInfoSchema)),
      create: sensitive('tokens.manage')
        .input(z.object({ label: z.string().min(1).max(80) }))
        .output(TokenCreatedSchema),
      revoke: sensitive('tokens.manage')
        .input(z.object({ id: z.string() }))
        .output(z.object({ ok: z.literal(true) })),
    },
  },
  /**
   * The protocol engine (hypothalamus.md "RPC"). A person reads and changes their own protocols with `chat`; the owner
   * reads all of them, and reads of a member's protocols or runs are audited (`acl.owner-access`). The owner-only
   * parts (`keith`-owned protocols, `act` steps, the pre-approval) are checked in the service, not only here. The
   * settings are read by anyone and changed by the owner with a step-up.
   */
  protocols: {
    list: can('chat').output(ProtocolListOutputSchema),
    get: can('chat').input(ProtocolRefSchema).output(ProtocolViewSchema),
    save: can('chat').input(ProtocolSaveInputSchema).output(ProtocolViewSchema),
    setEnabled: can('chat').input(ProtocolSetEnabledInputSchema).output(ProtocolViewSchema),
    pause: can('chat').input(ProtocolPauseInputSchema).output(ProtocolViewSchema),
    delete: can('chat')
      .input(ProtocolRefSchema)
      .output(z.object({ ok: z.literal(true) })),
    runs: can('chat').input(ProtocolRunsInputSchema).output(ProtocolRunsOutputSchema),
    /** An answer to a question a run asked the caller: only the run's own person (the procedure checks it). */
    answer: can('chat').input(ProtocolAnswerInputSchema).output(ProtocolAnswerOutputSchema),
    proposals: can('chat').output(ProtocolProposalsOutputSchema),
    confirm: can('chat').input(ProtocolProposalRefSchema).output(ProtocolViewSchema),
    dismiss: can('chat')
      .input(ProtocolProposalRefSchema)
      .output(z.object({ ok: z.literal(true) })),
    settings: {
      get: can('settings.read').output(ProtocolSettingsSchema),
      set: sensitive('settings.manage')
        .input(ProtocolSettingsSetSchema)
        .output(ProtocolSettingsSchema),
    },
  },
  /**
   * The personal agenda (hypothalamus.md "Agenda", ADR-0025 §2). A person reads and changes their own items with `chat`;
   * the owner reads a member's items with `person`, and that read is audited (`acl.owner-access`). Nothing here names a
   * person to write for: an add is always the caller's.
   */
  agenda: {
    list: can('chat').input(AgendaListInputSchema).output(AgendaListOutputSchema),
    add: can('chat').input(AgendaAddInputSchema).output(AgendaItemSchema),
    done: can('chat').input(AgendaRefSchema).output(AgendaItemSchema),
    cancel: can('chat').input(AgendaRefSchema).output(AgendaItemSchema),
  },
  /**
   * Shared rooms, the group call with Keith (docs/specs/corpus-callosum.md "RPC"). Every call is `chat` unless noted; the
   * service checks the membership and the control rule. `rooms.start` needs the `rooms.start` capability (a member by
   * grant). A room the caller may not see answers `NOT_FOUND`. `rooms.confirm` settles a `room_requests` row (remove, end, post): only the person it names confirms it, or the owner for a remove or an end (corpus-callosum.md "Control confirmations").
   */
  rooms: {
    start: can('rooms.start').input(RoomsStartInputSchema).output(RoomViewSchema),
    invite: can('chat').input(RoomsInviteInputSchema).output(RoomViewSchema),
    accept: can('chat').input(RoomsAcceptInputSchema).output(RoomViewSchema),
    decline: can('chat').input(RoomsDeclineInputSchema).output(RoomsOkSchema),
    say: can('chat').input(RoomsSayInputSchema).output(RoomsSayOutputSchema),
    leave: can('chat').input(RoomsLeaveInputSchema).output(RoomsOkSchema),
    remove: can('chat').input(RoomsRemoveInputSchema).output(RoomsOkSchema),
    end: can('chat').input(RoomsEndInputSchema).output(RoomsOkSchema),
    confirm: can('chat').input(RoomsConfirmInputSchema).output(RoomsConfirmOutputSchema),
    get: can('chat').input(RoomsGetInputSchema).output(RoomViewSchema),
    list: can('chat').input(RoomsListInputSchema).output(RoomsListOutputSchema),
    events: can('chat').input(RoomsEventsInputSchema).output(RoomsEventsOutputSchema),
    files: can('chat').input(RoomsFilesInputSchema).output(RoomsFilesOutputSchema),
    /** The six room settings: read by anyone, changed by the owner with a step-up (docs/specs/corpus-callosum.md "Settings"). */
    settings: {
      get: can('settings.read').output(RoomSettingsSchema),
      set: sensitive('settings.manage').input(RoomSettingsSetSchema).output(RoomSettingsSchema),
    },
  },
  /**
   * The persona and the per-person style (docs/specs/prefrontal.md, ADR-0029). `persona.get` is read by every person who can
   * chat. The persona is global: `setTemplate`, `edit` and `restore` are owner only (`settings.manage`) with a step-up from a
   * remote caller, and each writes one version. `history` is owner only (`audit.read`). A person reads and sets their own style
   * with `chat`; `style.read` is the owner's audited read of another person's style (`audit.read`, acl.owner-access).
   */
  persona: {
    get: can('chat').output(PersonaViewSchema),
    history: can('audit.read').output(z.array(PersonaVersionSchema)),
    setTemplate: sensitive('settings.manage')
      .input(PersonaSetTemplateInputSchema)
      .output(PersonaViewSchema),
    edit: sensitive('settings.manage').input(PersonaEditInputSchema).output(PersonaViewSchema),
    restore: sensitive('settings.manage')
      .input(PersonaRestoreInputSchema)
      .output(PersonaViewSchema),
    style: {
      get: can('chat').output(PersonStyleSchema),
      set: can('chat').input(PersonaStyleSetInputSchema).output(PersonStyleSchema),
      read: can('audit.read').input(PersonaStyleReadInputSchema).output(PersonStyleSchema),
    },
  },
  /**
   * The context reset and manual compaction of the caller's own front session (docs/specs/chat-context.md, ADR-0030). Every
   * call is `chat` and changes only the caller's session: the principal is the person, no argument names another person, and
   * no step-up applies. A busy session, a pending approval or a running task refuses a reset with `CONFLICT` (`data.reason`).
   */
  chat: {
    newContext: can('chat').input(ChatNewContextInputSchema).output(ChatNewContextOutputSchema),
    compact: can('chat').input(ChatCompactInputSchema).output(ChatCompactOutputSchema),
    generations: can('chat').output(ChatGenerationsOutputSchema),
    history: can('chat').input(ChatHistoryInputSchema).output(ChatHistoryOutputSchema),
  },
  /**
   * The memory dreaming (docs/specs/dreaming.md, ADR-0031). Every call is `chat` and acts only for the caller (the principal),
   * with two exceptions: `diary` names a `personId` (the owner's audited read of a member's diary, ADR-0020 §4; a member is
   * refused), and `settings` holds the instance's member default and the run cap (owner only, `settings.manage`, step-up for
   * a remote caller). A refusal is a `CONFLICT` with `data.reason` (`DreamRefusalDataSchema`). `now` starts a run now; `apply`
   * writes a staged plan; `undo` restores the preimages of an applied run.
   */
  dream: {
    status: can('chat').output(DreamStatusViewSchema),
    mode: can('chat').input(DreamModeInputSchema).output(DreamStatusViewSchema),
    now: can('chat').output(DreamRunViewSchema),
    apply: can('chat').input(DreamApplyInputSchema).output(DreamRunViewSchema),
    undo: can('chat').input(DreamUndoInputSchema).output(DreamUndoOutputSchema),
    diary: can('chat').input(DreamDiaryInputSchema).output(DreamDiaryOutputSchema),
    settings: {
      get: can('settings.read').output(DreamingSettingsSchema),
      set: sensitive('settings.manage')
        .input(DreamingSettingsSetSchema)
        .output(DreamingSettingsSchema),
    },
  },
  /**
   * The activity logs of model calls (docs/specs/activity-logs.md, ADR-0032). `mine` reads the caller's own sessions (every role);
   * the owner reads another person's through the audited owner path (`logs.read`, checked per row by the handler). `settings`
   * is the owner's, instance-wide. `purge` removes the caller's bodies or whole log; the owner may name a `person`.
   */
  logs: {
    status: can('logs.mine').output(LogsStatusSchema),
    settings: {
      get: can('logs.read').output(LogsSettingsSchema),
      set: sensitive('logs.read').input(LogsSettingsSetSchema).output(LogsSettingsSchema),
    },
    sessions: can('logs.mine').input(LogsSessionsInputSchema).output(LogsSessionsOutputSchema),
    session: can('logs.mine').input(LogsSessionInputSchema).output(LogsSessionOutputSchema),
    call: can('logs.mine').input(LogsCallInputSchema).output(LogsCallOutputSchema),
    raw: can('logs.mine').input(LogsRawInputSchema).output(LogsRawOutputSchema),
    purge: sensitive('logs.mine').input(LogsPurgeInputSchema).output(LogsPurgeOutputSchema),
  },
  /**
   * Resource access (ADR-0015, docs/specs/acl.md). The capability is `authenticated`: the handler checks the
   * caller's right on the resource itself (its owner, or the instance owner), at execution time. A refusal
   * reads the same for a missing and a denied resource. Widening to `@public` or `@users` needs a step-up
   * (checked in the handler); `chown` is the instance owner's alone.
   */
  acl: {
    show: can('authenticated').input(ResourceRefSchema).output(AclViewSchema),
    share: can('authenticated').input(AclShareSchema).output(AclViewSchema),
    unshare: can('authenticated').input(AclUnshareSchema).output(AclViewSchema),
    chmod: can('authenticated').input(AclChmodSchema).output(AclViewSchema),
    chgrp: can('authenticated').input(AclChgrpSchema).output(AclViewSchema),
    chown: sensitive('people.manage').input(AclChownSchema).output(AclViewSchema),
  },
  models: {
    roles: {
      get: can('settings.read').output(ModelRolesSchema),
      set: sensitive('settings.manage')
        .input(z.object({ role: ModelRoleSchema, ref: ModelRefSchema }))
        .output(ModelRolesSchema),
    },
    price: {
      /** Manual prices the owner set (`settings.read`: every caller may see what is priced by hand). */
      list: can('settings.read').output(z.array(ModelPriceSchema)),
      set: sensitive('settings.manage').input(ModelPriceSchema).output(ModelPriceSchema),
      clear: sensitive('settings.manage')
        .input(ModelPriceClearSchema)
        .output(z.object({ ok: z.literal(true) })),
    },
  },
}

export type KeithContract = typeof keithContract
