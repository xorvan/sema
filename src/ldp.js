var jsonld = require("jsonld").promises()
	, co = require("co")
	, sys = require("sys")
	, Q = require("q")
	, utile = require("utile")
	, querystring = require("querystring")
	, path = require("path")
	, url = require("url")
	, joinPath = require("./joinPath.js")
	, getRawBody = require('raw-body')
	, fs = require('co-fs')
	, send = require('koa-send');
;

function flatten(framed, id){
	// console.log("flatting", id, framed);
	var base = framed["@context"] && framed["@context"]["@base"], r = {}, graph = framed["@graph"];

	for(var i = 0; i < graph.length; i++){
		// console.log(id, (base ? url.resolve(base, graph[i]["@id"]) : graph[i]["@id"] ))
		if(id == (base ? url.resolve(base, graph[i]["@id"]) : graph[i]["@id"] )){
			r = graph[i];
			break;
		}
	}
	r["@context"] = framed["@context"];
	// console.log("flatted", r)
	return r;
}

function addSubResources(pkg, path, res){
	if(pkg.hasSubResource){
		if(!res) res = {};
		pkg.hasSubResource.forEach(function(sr){
			res[sr.subResourceRelation] = {"@id": app.ns.resolve(joinPath(path, sr.pathTemplate))};
		}.bind(this));
	}
	return res;
}

var ldp = module.exports = function(app){

	app.type("ldp:Resource")
		.get(function *(next){
			var path = decodeURI(this.path)
			var pkg = this.rdf.Type.package;
			console.log(pkg)
			var resource = pkg.storageType == 'http://www.xorvan.com/ns/sema#NoStorage' ? {"@id": path} : yield app.db.query("describe ?resource {hint:Query hint:describeMode \"CBD\"}", {resource: path.iri()});
			// console.log("PATH IS", path, JSON.stringify(resource))
			this.body = resource.length ? this.body = yield new this.rdf.Type(resource, path) : this.body = yield new this.rdf.Type(path);

			yield next;

			//TODO: implementing ldp:RDFSource
			if(!this.body._readableState){
				this.body = addSubResources(pkg, path, this.body)
				this.body = yield new this.rdf.Type(this.body, path);
				var accepted;
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
						this.set("Link", '<?context>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"')

				}

			}
		})

		.put(function *(next){
			var res = yield* this.request.json();
			res["@id"] = app.ns.resolve(this.url);
			this.request.body = yield new this.rdf.Type(res, this.url)
			console.log("i have got a putttttt to ldp:resource   ", this.request.body)

			yield next;

			console.log("putting", this.url, this.request.body);
			this.body = yield app.db.put(this.url, this.request.body);
			console.log("puted");
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
				var pageSize = 10,  page = this.query.page * 1, offset = (page - 1) * pageSize;
				var package = utile.clone(app.getPackage(this.rdf.Type.id));

				if(package.membershipResourceTemplate){
					package.membershipResource = app.ns.resolve(url.resolve(this.path, package.membershipResourceTemplate));
				}
				// console.log("pkg", package);
				var qs;
				if(package.isMemberOfRelation){
					qs = "select (count(?s) as ?count) { ?s ?isMemberOfRelation ?membershipResource}";
				} else{
					qs = "select (count(?s) as ?count) { ?membershipResource ?hasMemberRelation ?s}";
				}

				package.isMemberOfRelation = package.isMemberOfRelation || "";
				package.hasMemberRelation = package.hasMemberRelation || "";
				var r = yield app.db.query(qs, {
					membershipResource: package.membershipResource.iri(),
					isMemberOfRelation: package.isMemberOfRelation.iri(),
					hasMemberRelation: package.hasMemberRelation.iri()
				});

				var count = r[0].count.value * 1;
				this.set("Link", "<http://www.w3.org/ns/ldp/Resource>; rel='type'");
				this.set("Link", "<http://www.w3.org/ns/ldp/Page>; rel='type'");

				if(offset >= count){
					// return this.status = 404;
				}else if(offset + pageSize < count){
					var np = utile.clone(this.query);
					np.page ++;
					this.set("Link", "<?"+querystring.stringify(np)+">; rel='next'");
				}

				var qs;
				if(package.isMemberOfRelation){
					qs = "construct {?s ?p ?o} { {select ?s { ?s ?isMemberOfRelation ?membershipResource} limit ?limit offset ?offset} ?s ?p ?o}";
				} else{
					qs = "construct {?s ?p ?o} { {select ?s { ?membershipResource ?hasMemberRelation ?s} limit ?limit offset ?offset} ?s ?p ?o}";
				}

				this.body["ldp:membershipResource"] = package.membershipResource;
				if(package.isMemberOfRelation){
					this.body["ldp:isMemberOfRelation"] = package.isMemberOfRelation;
				}else{
					this.body["ldp:hasMemberRelation"] = package.hasMemberRelation;
				}
				this.body["ldp:insertedContentRelation"] = package.insertedContentRelation;

				this.body["$members"] = yield app.db.query(qs, {
					limit: pageSize,
					offset: offset,
					membershipResource: package.membershipResource.iri(),
					isMemberOfRelation: package.isMemberOfRelation.iri(),
					hasMemberRelation: package.hasMemberRelation.iri()
				});

				// console.log("con body", this.body);

				yield next;

			}
		})
		.post(function *(next){
			var res = this.request.body
				, slug = this.header.slug
				, p = this.rdf.Type.package
				, T = app.type(p.expectedType || app.ns.resolve("owl:Thing"))
				, types = yield T.type();
			;

			// Removing spaces and colons from slug
			if(slug){
				slug = slug.replace(/( |:)/g, "_");
			}

			console.log("expected type", types);
			if(~types.indexOf("http://www.w3.org/ns/ldp#NonRDFSource")){
				res = yield new T("new");
				res.value = yield getRawBody(this.req, {
			    length: this.length,
			    limit: '1mb',
			    encoding: this.charset
			  });

				var location = yield res.$identify(slug);
				var p = path.join(app.env.nonRDFSourceRoot, location);
				console.log("binary", p, res)

				yield fs.writeFile(p, res.value);

				this.set("Location", location);
				this.status = 201;

			}else{
				console.log("new resource posted", res)
				res["@id"] = app.ns.resolve("new");
				if(this.is('application/json')){
					if(!res["@type"]){
						res["@type"] = types;
					}else{
						var ct = res["@type"] instanceof Array ? res["@type"] : [res["@type"]]
						res["@type"] = ct.concat(types);
					}
					res["@context"] = app.getFrame(types)["@context"];
					res["@context"]["@base"] = app.ns.resolve(this.path)
				}
				// console.log("p is ", p)
				// console.log("posted is ", res )

				if(p.isMemberOfRelation){
					//TODO: insertedContentRelation checking
					var membershipResource = p.membershipResourceTemplate ? app.ns.resolve( url.resolve(this.path, p.membershipResourceTemplate) ) : p.membershipResource;

					res[p.isMemberOfRelation] = {"@id" : membershipResource};
				}
				console.log("parsing resource", res)
				res = yield new T(res);
				this.request.body = res;

				yield next;

				var id = yield res.$identify(slug);
				res["@id"] = app.ns.resolve(id);

				var triples = yield jsonld.toRDF(res, {format: 'application/nquads'});
				console.log("salam", triples, T.package, res)
				yield app.db.update("INSERT DATA { ?triples }", {triples: triples})
				// this.body = yield app.db.query("describe ?id", {id: res["@id"].iri()});
				this.set("Location", encodeURI(id));
				this.status = 201;

				console.log("end of new resource posted", res)
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
			}
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
	var types;
	if(typeof graph == "string"){
		id = this.app.ns.resolve(graph);
		graph = undefined;
	}
	if(graph){
		var id = id && this.app.ns.resolve(id) || graph["@id"];
		if(!id)
			throw new Error("No id specified for " + JSON.stringify(graph));
		graph = yield jsonld.expand(graph);

		for(var i=0; i< graph.length; i++){
			if(graph[i]["http://www.w3.org/1999/02/22-rdf-syntax-ns#type"]){
				graph[i]["@type"] = graph[i]["http://www.w3.org/1999/02/22-rdf-syntax-ns#type"].map(function(t){return t["@id"]});
				delete graph[i]["http://www.w3.org/1999/02/22-rdf-syntax-ns#type"];
			}
			if(graph[i]["@id"] == id){
				types = graph[i]["@type"] = graph[i]["@type"] ? graph[i]["@type"].concat(yield this.type()) : yield this.type();
				break;
			}
		}
		if(!types){
			console.log("Warning: Invalid ID! Could not find " + id + " in " + JSON.stringify(graph))
			// console.log("conss", arguments.callee)

			var deferred = Q.defer();
			co(arguments.callee).call(this, id, null, deferred.makeNodeResolver() );
			return deferred.promise;

			throw Error("Invalid ID! Could not find " + id + " in " + JSON.stringify(graph));
			return false;
		}
	}else{
		types = yield this.type();
		graph = {"@type": types, "@id": id};
	}
	var frame = this.app.getFrame(types)
	// frame["@context"]["@base"] = id;
	if(this.app.ns.vocab) frame["@context"]["@vocab"] = this.app.ns.vocab;
	this._frame = frame;
	var resource = flatten(yield jsonld.frame(graph, frame), id);
	resource.__proto__ = this.__proto__;
	if(~types.indexOf(this.app.ns.resolve("ldp:Container"))){
		resource.__proto__.__proto__ = Container$;
		resource.bindMembers(graph);
	}
	// console.log("restouce is ", resource)
	return resource;
})

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
