module.exports = (api) => {
  api.cache(true);

  const presets = [
    ['@babel/preset-env', {
      targets: {
        node: 4.3,
      },
    }],
  ];

  return { presets };
};
