var path = require('path');

module.exports = function joinPath(){
  return path.join.apply(path, arguments).replace(/\\/g, "/");
}
