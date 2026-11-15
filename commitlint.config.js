// Conventional Commits with Keith scopes: packages, repo areas and brain regions.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        // apps and packages
        'core',
        'node',
        'tui',
        'contracts',
        'db',
        'eh-ext',
        'host',
        'client',
        'acl',
        // repo areas
        'deps',
        'ci',
        'repo',
        // brain regions and core modules
        'thalamus',
        'wernicke-broca',
        'cortex',
        'providers',
        'motor',
        'amygdala',
        'ras',
        'hippocampus',
        'tasks',
        'nodes',
        'brain-events',
        'auth',
        'cli',
        'ui',
        'web',
        'app-model',
        'push',
      ],
    ],
  },
}
