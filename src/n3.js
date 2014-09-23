var Q = require("q")
  , N3 = require("n3")
;

var parser = N3.Parser();

module.exports.parse = function(input, serialization){
  var deferred = Q.defer();
  var triples = [];
  parser.parse(input, function(err, triple, prefixes){
    if(!err){
      if(triple)
        triples.push(triple);
      else
        deferred.resolve(serialization ? serialize(triples) : triples);
    }else{
      deferred.reject(err);
    }
  });
  return deferred.promise;
}

var escape = module.exports.escape = function(value){
  if(N3.Util.isLiteral(value)){
    return '"' + N3.Util.getLiteralValue(value).replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\"/g, '\\"') + '"^^<' + N3.Util.getLiteralType(value) + ">"
  }else{
    return N3.Util.isUri(value) ? "<"+value+">" : value;  
  }  
  
}

var tripleMapper = function(t){
  return escape(t.subject) + " " + escape(t.predicate) + " " + escape(t.object) + " .";
}

var serialize = module.exports.serialize = function(triples, serialization){
  switch(serialization){
    default:
      return triples.map(tripleMapper).join("\n");
  }
}
