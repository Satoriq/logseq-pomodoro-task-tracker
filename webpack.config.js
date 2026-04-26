const path = require("path");

const isProd = process.env.NODE_ENV === "production";

module.exports = {
  entry: "./src/index.ts",
  mode: isProd ? "production" : "development",
  devtool: isProd ? false : "eval-source-map",
  optimization: { minimize: isProd },
  output: {
    filename: "index.js",
    path: path.resolve(__dirname, "dist"),
    clean: true,
    library: {
      type: "umd",
      name: "LogseqPlugin",
    },
  },
  resolve: {
    extensions: [".ts", ".js", ".scss"],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
      {
        test: /\.svg$/,
        type: "asset/resource",
        generator: {
          filename: "[name][ext]",
        },
      },
      {
        test: /\.scss$/,
        type: "asset/source",
      },
    ],
  },
  externals: [],
};
