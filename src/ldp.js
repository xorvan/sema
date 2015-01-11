var jsonld = require("jsonld").promises()
	, debug = require("debug")("sema:ldp")
	, co = require("co")
	, thunkify = require("thunkify")
	, sys = require("sys")
	, Q = require("q")
	, utile = require("utile")
	, querystring = require("querystring")
	, path = require("path")
	, url = require("url")
	, joinPath = require("./joinPath.js")
	, getRawBody = require('raw-body')
	, fs = require('co-fs')
	, send = require('koa-send')
	,	uuid = require("node-uuid")
;

function flatten(framed, id){
	var base = framed["@context"] && framed["@context"]["@base"], r = {}, graph = framed["@graph"];

	for(var i = 0; i < graph.length; i++){
		if(id == (base ? url.resolve(base, graph[i]["@id"]) : graph[i]["@id"] )){
			r = graph[i];
			break;
		}
	}
	r["@context"] = framed["@context"];
	return r;
}

function addSubResources(pkg, path, res){
	if(pkg.hasSubResource){
		if(!res) res = {};
		pkg.hasSubResource.forEach(function(sr){
			if(!~sr.pathTemplate.indexOf("{slug}")){
				debug("Adding Sub Resource", path, sr.pathTemplate, sr)
				res[sr.subResourceRelation] = {"@id": app.ns.resolve(joinPath(path, sr.pathTemplate))};
			}
		}.bind(this));
	}
	debug("Adding Sub Resources", pkg, path, res)
	return res;
}

var ldp = module.exports = function(app){

	app.type("ldp:Resource")
		.get(function *(next){
			var pkg = this.rdf.Type.package, path = decodeURI(this.path), dbr;

			debug("Getting LDP Resource, package", path, pkg);
			var resource = pkg.storageType == 'http://www.xorvan.com/ns/sema#NoStorage' ? {"@id": path} : dbr = yield app.db.query("describe ?resource {hint:Query hint:describeMode \"CBD\"}", {resource: path.iri()});
			debug("Getting LDP Resource, resource", resource);
			this.body = resource.length ? this.body = yield new this.rdf.Type(resource, path) : this.body = yield new this.rdf.Type(path);
			debug("Getting LDP Resource, body", this.body);
			if(dbr && dbr.length === 0 ){
				this.status = 404;
			}
			
			this.link = this.response.header.link = ["<http://www.w3.org/ns/ldp#Resource>; rel='type'"];

			yield next;

			if(this.isRDFSource){
				this.body = addSubResources(pkg, path, this.body)
				this.body = yield new this.rdf.Type(this.body);

				this.link.push("<http://www.w3.org/ns/ldp#RDFSource>; rel='type'");

				var accepted;
				debug("Checking Accept Type")
				switch(accepted = this.accepts(["application/ld+json", "text/plain", "application/nquads", "text/n3", "text/turtle", "application/json"])){
					case "application/ld+json":
						this.set("Content-Type", "application/ld+json");
						break
					case "text/plain":
					case "application/nquads":
					case "text/turtle":
					case "text/n3":
						this.set("Content-Type", accepted);

						this.body = yield jsonld.toRDF(this.body, {format: 'application/nquads'})
						break
					case "application/json":
					default:
						this.set("Content-Type", "application/json");
						delete this.body["@context"];
						this.link.push('<?context>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"');

				}

			}

			// otherwise header name will be undefined!!!
			this.set('Link', this.response.header.link);
		})

		.delete(function *(next){
			var pkg = this.rdf.Type.package, path = decodeURI(this.path), dbr;

			var resource = pkg.storageType == 'http://www.xorvan.com/ns/sema#NoStorage' ? {"@id": path} : dbr = yield app.db.query("describe ?resource {hint:Query hint:describeMode \"CBD\"}", {resource: path.iri()});
			this.body = yield new this.rdf.Type(resource, path)
			debug("Deleteing Resource Current", this.path, this.body)

			this.sparql = {
				update: "DELETE WHERE { ?resource }",
				params: {}
			}

			yield next;

			if(dbr){
				var triples = yield jsonld.toRDF(this.body, {format: 'application/nquads'});
				this.sparql.params.resource = triples.replace(/_:b/g, "?b");

				yield app.db.update(this.sparql.update, this.sparql.params)

				this.status = 204;
			}

		})

		.put(function *(next){
			var pkg = this.rdf.Type.package, path = decodeURI(this.path), dbr;

			var newRes = this.request.body;
			newRes["@id"] = path;
			this.request.body = yield new this.rdf.Type(newRes, path)
			debug("Putting Resource Requested", this.path, path)

			var resource = pkg.storageType == 'http://www.xorvan.com/ns/sema#NoStorage' ? {"@id": path} : dbr = yield app.db.query("describe ?resource {hint:Query hint:describeMode \"CBD\"}", {resource: path.iri()});

			this.body = yield new this.rdf.Type(resource, path)
			debug("Putting Resource Current", this.path, this.body)

			this.sparql = {
				update: "DELETE { ?resource } INSERT{ ?newResource } WHERE { ?resolver }",
				params: {}
			}

			yield next;

			if(dbr){
				debug("Putting Resource New", this.url, this.request.body);

				var triples = yield jsonld.toRDF(this.request.body, {format: 'application/nquads'});
				this.sparql.params.newResource = triples;

				var triples = yield jsonld.toRDF(this.body, {format: 'application/nquads'});
				this.sparql.params.resource = triples.replace(/_:b/g, "?b");

				this.sparql.params.resolver = this.sparql.params.resource
					.split("\n")
					.filter(function(triple){return triple.indexOf("?b") != -1 })
					.join("\n")

				yield app.db.update(this.sparql.update, this.sparql.params)

				this.status = 204;
			}
		})

		.frame({
			"@context": {
				"ldp": "http://www.w3.org/ns/ldp#"
			}
		})
	;

	app.type("ldp:NonRDFSource")
		.get(function *(next){
			yield send(this, this.path, { root: app.env.nonRDFSourceRoot } );
		})
	;

	app.type("ldp:Container")
		.get(function *(next){
			if(!this.query.page){
				var query = this.query;
				query.page = 1;
				this.set("Location", "?"+ querystring.stringify(query));
				this.status = 303;
			}else{
				this.status = 200;
				var pageSize = 20,  page = this.query.page * 1, offset = (page - 1) * pageSize;
				var package = utile.clone(app.getPackage(this.rdf.Type.id));
				var useDB = this.rdf.Type.package.storageType != 'http://www.xorvan.com/ns/sema#NoStorage';

				console.log("Storage Type", this.rdf.Type.package.storageType)

				if(package.membershipResourceTemplate){
					var membershipResource = decodeURI(app.ns.resolve(url.resolve(this.path, package.membershipResourceTemplate)));
				}else{
					var membershipResource = app.ns.resolve(package.membershipResource || "");
				}

				this.sparql = {
					params: {}
				}


				var qs;
				if(package.isMemberOfRelation){
					this.sparql.count = "select (count(?s) as ?count) { ?s ?isMemberOfRelation ?membershipResource}";
					var isMemberOfRelation = app.ns.resolve(package.isMemberOfRelation),
						hasMemberRelation = "";

				} else{
					this.sparql.count = "select (count(?s) as ?count) { ?membershipResource ?hasMemberRelation ?s}";
					var  hasMemberRelation = app.ns.resolve(package.hasMemberRelation),
						isMemberOfRelation = "";

				}

				this.sparql.params = {
					membershipResource: membershipResource.iri(),
					isMemberOfRelation: isMemberOfRelation.iri(),
					hasMemberRelation: hasMemberRelation.iri(),
 					filter: "",
 					template: "?s ?p ?o",
 					pattern: "?s ?p ?o"
				};

				var qs;
				this.sparql.query = "construct {?template} { {select ?s { "
				if(package.isMemberOfRelation){
					this.sparql.query += "?s ?isMemberOfRelation ?membershipResource ."
				}else{
					this.sparql.query += "?membershipResource ?hasMemberRelation ?s ."
				}
				
				this.sparql.query += " ?filter } limit ?limit offset ?offset} ?pattern}";

				this.body["ldp:membershipResource"] = membershipResource;
				if(package.isMemberOfRelation){
					this.body["ldp:isMemberOfRelation"] = isMemberOfRelation;
				}else{
					this.body["ldp:hasMemberRelation"] = hasMemberRelation;
				}
				this.body["ldp:insertedContentRelation"] = package.insertedContentRelation;

				this.container = {
					limit: pageSize,
					offset: offset,
					count: 0
				};

				yield next;

				if(useDB){
					this.sparql.params.limit = this.container.limit;
					this.sparql.params.offset = this.container.offset;

					var r = yield app.db.query(this.sparql.count, this.sparql.params)
					this.container.count = r[0].count.value * 1;
				}

				var count = this.container.count;

				console.log("ontainer", this.container)
				if(this.sparql.params.offset >= count){
					// return this.status = 404;
				}else if(count > this.container.limit){
					this.link.push("<http://www.w3.org/ns/ldp#Page>; rel='type'");

					var op = utile.clone(this.query);
					op.page = 1;
					this.link.push("<?" + querystring.stringify(op) + ">; rel='first'");
					op.page = ((count / this.container.limit) | 0) + 1;
					this.link.push("<?" + querystring.stringify(op) + ">; rel='last'");
					delete op.page;
					this.link.push("<?" + querystring.stringify(op) + ">; rel='canonical'");

					if(this.container.offset + this.container.limit < count){
						var np = utile.clone(this.query);
						np.page ++;
						this.link.push("<?" + querystring.stringify(np) + ">; rel='next'");
					}

					if(this.container.offset != 0){
						var pp = utile.clone(this.query);
						pp.page --;
						this.link.push("<?" + querystring.stringify(pp) + ">; rel='prev'");
					}

				}

				var db = this.rdf.Type.package.expectedType ? app.type(this.rdf.Type.package.expectedType) : app.db;
				if(useDB){
					this.body["$members"] = yield db.query(this.sparql.query, this.sparql.params);
				}
				this.body = yield new this.rdf.Type(this.body);

				debug("Container Get Resource", this.body)
			}
		})
		.post(function *(next){
			var res = this.request.body
				, slug = this.header.slug
				, p = this.rdf.Type.package
				, T = app.type(p.expectedType || app.ns.resolve("owl:Thing"))
				, types = yield T.type()
				, useDB = p.storageType != 'http://www.xorvan.com/ns/sema#NoStorage'
			;

			// Removing spaces and colons from slug
			if(slug){
				slug = slug.replace(/( |:)/g, "_");
			}

			debug("New post on Container, Expected type:", types);

			if(~types.indexOf("http://www.w3.org/ns/ldp#NonRDFSource")){
				res = yield new T("new");
				res.value = yield getRawBody(this.req, {
			    length: this.length,
			    limit: '100mb',
			    encoding: this.charset
			  });

				var location = yield res.$identify(slug);
				var p = path.join(app.env.nonRDFSourceRoot, location);

				yield fs.writeFile(p, res.value);

				this.set("Location", location);
				this.status = 201;

			}else{
				debug("Posted RDFSource: ", res)

				res["@id"] = url.resolve(app.ns.resolve(decodeURI(this.path)), "new");
				if(!res["@type"]){
					res["@type"] = types;
				}else{
					var ct = res["@type"] instanceof Array ? res["@type"] : [res["@type"]]
					res["@type"] = ct.concat(types);
				}
				
				if(this.is('application/json') && !res["@context"]){
					res["@context"] = app.getFrame(res["@type"])["@context"];
					res["@context"]["@base"] = app.ns.resolve(this.path)
					debug("Posted was json context added ", res)
				}

				if(p.isMemberOfRelation){
					//TODO: insertedContentRelation checking
					var membershipResource = p.membershipResourceTemplate ? app.ns.resolve( url.resolve(this.path, p.membershipResourceTemplate) ) : p.membershipResource;
					res[p.isMemberOfRelation] = {"@id" : membershipResource};
				}

				res = yield new T(res);
				this.request.body = res;

				this.sparql = {
					update: "INSERT DATA { ?newResource }",
					params: {}
				}

				yield next;

				if(useDB){
					res = this.request.body;
					var id = yield res.$identify(slug);
					res["@id"] = app.ns.resolve(id);
					debug("Inserting resource to DB", JSON.stringify(res))

					var triples = yield jsonld.toRDF(res, {format: 'application/nquads'});
					this.sparql.params.newResource = triples;

					yield app.db.update(this.sparql.update, this.sparql.params)
					// this.body = yield app.db.query("describe ?id", {id: res["@id"].iri()});
					this.set("Location", encodeURI(id));
					this.status = 201;
				}
			}
		})
		.frame({
			"@context": {
				"ldp": "http://www.w3.org/ns/ldp#",
				"ldp:isMemberOfRelation": {"@type": "@id"},
				"ldp:hasMemberRelation": {"@type": "@id"},
				"ldp:membershipResource": {"@type": "@id"},
				"ldp:insertedContentRelation": {"@type": "@id"},
				"$members": {"@id": "ldp:contains", "@container": "@set"}
			},
			"$members": {"@embed": true}
		})

	;
	return ldp;
}


ldp.Resource = function (app, graph, id){
	this.app = app;

	var deferred = Q.defer();
	this.process(graph, id, deferred.makeNodeResolver());
	return deferred.promise;
}

var Resource$ = ldp.Resource.prototype;

Resource$.type = function(){
	return Q([]);
};

Resource$.$identify = function (proposed){
	return this.constructor.identify(this, proposed);
}

Resource$.$slug = function(proposed){
	return this.constructor.slug(this, proposed);
}

// Resource$.__defineGetter__("json", function(){
// 	return utile.clone(this);
// });


Resource$.process = co(function *(graph, id){
	var types, frame;
	if(typeof graph == "string"){
		id = this.app.ns.resolve(graph);
		graph = undefined;
	}
	if(graph){
		var newId;
		var id = id && this.app.ns.resolve(id) || graph["@id"];
		if(!id){
			graph["@id"] = id = newId = "urn:uuid:" + uuid.v4();
		}

		if(graph.length === undefined && (!graph["@context"] || !graph["@context"]["@base"])){
			if(!graph["@context"]){
				types = yield this.type();
				frame = this.app.getFrame(types);
				graph["@context"] = frame["@context"] || {};
			}

			graph["@context"]["@base"] = this.app.ns.base;
		}
		debug("Processing Resource graph", graph);
		graph = yield jsonld.expand(graph);
		debug("Expanded Resource graph", graph);

		for(var i=0; i< graph.length; i++){
			var g = graph[i];
			if(!g["@type"])
				g["@type"] = [];
			if(g["http://www.w3.org/1999/02/22-rdf-syntax-ns#type"]){
				g["@type"] = g["@type"].concat(g["http://www.w3.org/1999/02/22-rdf-syntax-ns#type"].map(function(t){return t["@id"]}));
				delete g["http://www.w3.org/1999/02/22-rdf-syntax-ns#type"];
			}
			if(g["@id"] == id){
				types = g["@type"] = g["@type"].concat(yield this.type());
				break;
			}
		}
		if(!types){
			console.log("Warning: Invalid ID! Could not find " + id + " in " + JSON.stringify(graph))

			var deferred = Q.defer();
			co(arguments.callee).call(this, id, null, deferred.makeNodeResolver() );
			return deferred.promise;

			throw Error("Invalid ID! Could not find " + id + " in " + JSON.stringify(graph));
			return false;
		}
	}else{
		types = yield this.type();
		if(!id){
			id = newId = "urn:uuid:" + uuid.v4();
		}
		graph = {"@type": types, "@id": id};
	}
	debug("getting frame for", types);
	frame = frame || this.app.getFrame(types)
	// frame["@context"]["@base"] = id;
	delete frame["@context"]["@base"];
	frame["@type"] = this.id;
	if(this.app.ns.vocab) frame["@context"]["@vocab"] = this.app.ns.vocab;
	this._frame = frame;
	debug("Framing Resource", graph)
	debug("Framing Resource using", frame)
	var framed = yield jsonld.frame(graph, frame);
	debug("Framed Resource", framed)
	var resource = flatten(framed, id);
	if(resource["@id"] == newId){
		delete resource["@id"];
	}
	resource.__proto__ = this.__proto__;
	if(~types.indexOf(this.app.ns.resolve("ldp:Container"))){
		resource.__proto__.__proto__ = Container$;
		resource.bindMembers(graph);
	}
	return resource;
})

var actions = {
	'get': {method: "GET"},
	'put': {method: "PUT", autoData: true},
	'post': {method: "POST", autoData: true},
	'delete': {method: "DELETE"},
	'patch': {method: "PATCH"}
}

for (var name in actions){ (function(name, action){
	Resource$["$" + name] = thunkify(co(function *(params, data) {
		var app = this.constructor.app;

		if(!data && (typeof params != "string") && (!params || !params.rel) ){
			data = params;
			params = {rel: "self"};
		}

		if(!params) params = {rel: "self"};

		if(typeof params == "string") params = {rel: params};

		if(!data && action.autoData) data = this;

		var expanded = yield jsonld.expand(this);

		var resource = expanded[0],
			httpConfig = {method: action.method}
		;

		if(!params.rel || params.rel == "self"){
			httpConfig.path = resource["@id"];
		}else{
			var predicate = app.ns.resolve(params.rel),
				rel = resource[predicate];

			if(!rel)
				throw Error('badrel', "Relation "+ predicate +" not found in the resource " + resource);

			httpConfig.path = rel[0]["@id"];
		}

		if(data) httpConfig.entity = data;

		debug("Requesting", httpConfig, JSON.stringify(data));
		return yield app.http.request(httpConfig);

	}));
})(name, actions[name]) }

Resource$.$addReverse = function(rel, res){
	if(!this["@reverse"]){
		this["@reverse"] = {};
	}

	if(!this["@reverse"][rel]){
		this["@reverse"][rel] = [];
	}else if(this["@reverse"][rel].length === undefined){
		this["@reverse"][rel] = [this["@reverse"][rel]];
	}

	if(res.length === undefined){
		this["@reverse"][rel].push(res);
	}else{
		this["@reverse"][rel] = this["@reverse"][rel].concat(res);
	}
}

Resource$.$is = thunkify(co(function *(type){
	var app = this.constructor.app;

  var type = app.ns.resolve(type);
  var expanded = yield jsonld.expand(this);
  expanded = expanded[0];
  return expanded["@type"] && !!~expanded["@type"].indexOf(type);
}));


ldp.Container = function (app, graph, id){
	return this.constructor.super_.apply(this, arguments);
}

sys.inherits(ldp.Container, ldp.Resource);
var Container$ = ldp.Container.prototype;

Container$.bindMembers = function (graph){
	// this.$members = graph.slice ? graph.slice(1) : [];
	// this.$members = [];
	// if(this["ldp:isMemberOfRelation"]){
	// 	for(var i = 0; i < graph.length; i++){
	// 		var relation = this["ldp:isMemberOfRelation"];
	// 		if(relation == "rdf:type") relation = "@type";
	// 		var res = this["ldp:membershipResource"];
	// 		if(graph[i][relation].indexOf())
	// 		console.log("mmm",relation, graph[i]);
	// 	}
	// }
}

// Container$.__defineGetter__("json", function(){
// 	var r = utile.clone(this);
// 	delete r.$members;
// 	return [r].concat(this.$members);
// });
