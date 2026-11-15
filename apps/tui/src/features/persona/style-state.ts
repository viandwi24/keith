// The "Me" style form's state lives in `@keith/app-model` (shared with the web); the screens import it from here.
export {
  type AddressCheck,
  BREVITY_CHOICES,
  checkAddress,
  dirtyStyleFieldsOf,
  FORMALITY_CHOICES,
  LANGUAGE_CHOICES,
  STYLE_FIELD_LABELS,
  STYLE_FIELDS,
  type StyleDraft,
  type StyleField,
  type StyleProblem,
  styleDraftOf,
  stylePatchOf,
  TOPIC_CHOICES,
  toggleTopic,
} from '@keith/app-model'
