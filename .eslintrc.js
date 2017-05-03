module.exports = {
  "extends": "airbnb",
  "plugins": [
    "import"
  ],
  "env": {
    "browser": false,
    "node": true
  },
  "rules": {
    "no-unused-vars": [2, { "argsIgnorePattern": "^_" }],
    "max-len": ["error", 150]
  }
};
