var path = require('path');

module.exports = function joinPath(){
  var a = arguments[0];
  var pre = "";
  var parts = /(^https?\:\/\/)(.*)/.exec(a);
  if(parts){
    pre = parts[1];
    arguments[0] = parts[2];
  }
  return pre + path.join.apply(path, arguments).replace(/\\/g, "/");
}
