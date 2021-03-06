var koa = require("koa")
	, utile = require('utile')
	, url = require('url')
	, path = require('path')
	, assert = require('assert')
	, jsonld = require("jsonld").promises()
	, debug = require("debug")("sema:Application")
	, Q = require('q')
	, fs = require("fs")
	, rest = require('rest')
	, EventEmitter2 = require('eventemitter2').EventEmitter2
	, GraphStoreClient = require("graph-store-client")
	, co = require("co")
	, compose = require("koa-compose")
	, bodyParser = require('koa-body-parser')
	, sys = require("sys")
	, methods = require("./methods")
	, TypeWrapper = require("./TypeWrapper")
	, n3 = require('./n3')
	, ldp = require("./ldp.js")
	, owl = require("./owl.js")
	, joinPath = require("./joinPath.js")
	, diff = require("diff")
	, merge = require("merge")
;


var defaultEnv = {
	sparqlEndpoint: "http://localhost:5820/test/query"
	, graphStoreEndpoint: "http://localhost:5820/test"
	, cookieSecret: "Hermes is the God of Technology!"
	, secret: "Hermes is the God of Technology!"
	, host: "localhost:4000"
}

require("rest/mime/registry").register("application/ld+json", require("rest/mime/type/application/json"));

var locationInterceptor = require("rest/interceptor")({
	success: function (response, config, client) {
		if (response.headers && response.headers.Location) {
			var redirectPath = url.resolve(response.request.path, response.headers.Location);
			debug("Location Interceptor, Redirecting", response.request.path, response.headers.Location, redirectPath)
			return (config.client || (response.request && response.request.originator) || client.skip())({
				method: 'GET',
				path: redirectPath
			});
		}
		return response;
	}
});

var Application = module.exports = function Application(ontology){
	if (!(this instanceof Application)) return new Application(ontology);

	koa.call(this);
	EventEmitter2.call(this, {
		wildcard: true, // should the event emitter use wildcards.
		delimiter: '.', // the delimiter used to segment namespaces, defaults to `.`.
		newListener: false, // if you want to emit the newListener event set to true.
		maxListeners: 50, // the max number of listeners that can be assigned to an event, defaults to 10.
	});

	var self = this, routes = this.routes = {};

	methods.forEach(function(m){
		routes[m] = {};
	})

	//Setting up environment values
	try{
		this.env = JSON.parse(fs.readFileSync("env.json"))[process.env.NODE_ENV || 'development'];
	}catch(e){
		this.env = defaultEnv;
	}

	//Setting up DB
	this.db = new GraphStoreClient(this.env.sparqlEndpoint, this.env.graphStoreEndpoint);

	this.ns = this.db.ns;
	this.ns.base = this.env.host; //utile.format("http://%s", this.env.host);

	this.ns.register("sema", "http://www.xorvan.com/ns/sema#");

	this._configurators = [];

	//Loading Ontology
	if(typeof ontology == "string"){
		this.ontology = fs.readFileSync(ontology, "utf8");
	}else if(ontology instanceof Array){
		this.ontology = "";
		for(var i = 0; i < ontology.length; i++){
			var ont = ontology[i];
			this.ontology += fs.readFileSync(ont, "utf8");
		};
	}else{
		this.ontology = ontology;
	}


	this.typeMaps = [];
	this.framings = {};
	this._types = {};
	this._modules = [];

	this.http = new HTTP(this);

	//Installing Body Parser
	this.use(bodyParser());

	//Error handling
	this.use(require("koa-error")());

	this.use(function *(next){
		//Package Finder
		var rdf;
		for(var i = 0; i < self.typeMaps.length; i++){
			var pkg = this.app.typeMaps[i];
			if(pkg.regex.test(this.path)){
				var rdf = this.rdf = {};
				this.rdf.Type = self.type(pkg.type);
				this.rdf.type = yield this.rdf.Type.type();
				debug("rdf types", this.rdf.type);
				break;
			}
		}

		this.__defineGetter__("isRDFSource", function(){
			return rdf && !~rdf.type.indexOf("http://www.w3.org/ns/ldp#NonRDFSource");
		})

		yield next;
	})

}

var Application$ = Application.prototype;

Application$.__proto__ = utile.mixin(koa.prototype, EventEmitter2.prototype);

Application$.__SEMA_APPLICATION = true

Application$.use = function(mw){
	if(typeof mw == "object" && mw.__SEMA_APPLICATION){
		debug("Using Sema Application ...");
		this._modules.push(mw);

		// Merging middlewares
		for(var m in mw.routes){
			var r = mw.routes[m];
			for(t in r){
				var d = this.routes[m];
				d[t] = d[t] ? d[t].concat(r[t]) : r[t];
			}
		}

		//Merging types
		for(var tid in mw._types){
			var t = mw._types[tid],
				dt = this.type(tid);

			if(t.hasSlugger){
				dt.slug(t._slugger);
			}

			if(t.hasFrame){
				dt.frame(t.frame())
			}
		}

		//Merging HTTP interceptors
		this.http.interceptors = this.http.interceptors.concat(mw.http.interceptors);

		mw.env = this.env;
		mw.getPackage = mw.getPackage.bind(this);
		mw.__defineGetter__("rootPackage", function(){
			return this.rootPackage;
		}.bind(this))

		mw.configure();

	}else{
		return koa.prototype.use.call(this, mw);
	}
}

Application$.type = function(id){
	var id = this.ns.resolve(id), self = this;
	if(this._types[id]){
		return this._types[id];
	}else{
		var T = function(){
			return this.constructor.super_.apply(this, [self].concat(Array.prototype.slice.call(arguments)));
		}

		sys.inherits(T, ldp.Resource);
		utile.mixin(T, TypeWrapper.prototype)
		T.id = id;
		T.app = this;
		T.prototype.id = id;
		T.prototype.type = T.type;
		T.__defineGetter__("package", function(){
			return T.app.getPackage(T.id);
		})

		this._types[id] = T;

		return T;
	}

	// return new TypeWrapper(id, this);
}

Application$.getFrame = function(types){
	var f = {};
	if(!(types instanceof Array)){
		f = this.framings[types] || {};
	}else if(types.length == 1){
		f = this.framings[types[0]] || {};
	}else{
		var app = this;
		var args = types.map(function(type){
			return app.framings[type];
		})
		args.unshift(true);
		f = merge.recursive.apply(merge.recursive, args);
	}
	if(!f["@context"])
		f["@context"] = {};

	return f;
}

Application$.init = co(function *(rootPackageId){

	//Installing middlewares

	this.use(function *(next){
		if(!this.rdf){
			return yield next;
		}
		//Router
		var types = this.rdf.type, routes = self.routes[this.method.toLowerCase()], mw = [];
		for(var i = types.length -1 ; i >= 0; i--){
			var t;
			if(t = routes[types[i]]) mw = mw.concat(t);
		}
		if(mw.length){
			// yield compose(mw.concat(function *(){yield next}));
			yield compose(mw);
			yield next;
		}else{
			yield next;
		}
	})

	if(process.env.ONTOLOGY != "same"){
		try{

			console.log("Loading ontologies ...");

			var ontology = yield n3.parse(fs.readFileSync(__dirname + "/sema.ttl", "utf8"), "text/plain");
			if(this.ontology){
				ontology += yield n3.parse(this.ontology, "text/plain");
				console.log("Main ontology loaded!");
			}
			for(var i = 0; i < this._modules.length; i++){
				var m = this._modules[i];
				if(m.ontology){
					ontology += yield n3.parse(m.ontology, "text/plain");
					// console.log("Module " + (i+1) + " ontology loaded!", res);
				}
			}
			// ontology = ontology.replace(/\n/, "\\n");
			debug("Ontology is \n", ontology);

			if(fs.existsSync(".loadedOntology.ttl")){
				var prevOntology = fs.readFileSync(".loadedOntology.ttl");

				if( prevOntology == ontology){
					console.log("Ontology is the same!")
				}else{
					var diffs = diff.diffLines(prevOntology.toString(), ontology.toString());
					console.log("Ontology has been changed!", diffs.filter(function(cs){return cs.removed || cs.added}));
					var res = yield this.db.update("DELETE WHERE{ ?removedOntology } ; INSERT DATA{ ?addedOntology }", {
						removedOntology: diffs.filter(function(cs){return cs.removed}).map(function(cs){return cs.value}).join("\n").replace(/_:b/g, "?b"),
						addedOntology: diffs.filter(function(cs){return cs.added}).map(function(cs){return cs.value}).join("\n")
					});
					console.log("Ontology has been pushed to DB!", res)

					fs.writeFileSync(".loadedOntology.ttl", ontology);
					console.log(".loadedOntology.ttl updated!", res)
				}
			}else{
				console.log("Loading ontology for the first time!");
				fs.writeFileSync(".loadedOntology.ttl", ontology);
				var res = yield this.db.update("INSERT DATA { ?ontology }", {ontology: ontology});
				console.log("Ontology has been pushed to DB!", res)
			}

		}catch(e){
			throw new Error("Error loading ontology! " + e);
		}
	}

	//Installing Base Types
	owl(this);
	ldp(this);

	var packages = this.packages = yield jsonld.frame(
		yield this.db.query("describe ?s {?s a sema:Package}")
		,{
			"@context":
			{
				"@vocab": "http://www.xorvan.com/ns/sema#",
				"ldp": "http://www.w3.org/ns/ldp#",
				"ldpt": "http://www.xorvan.com/ns/sema/ldpt#",
				"rdfs": "http://www.w3.org/2000/01/rdf-schema#",
				"isMemberOfRelation": {"@type": "@id", "@id": "ldp:isMemberOfRelation"},
				"hasMemberRelation": {"@type": "@id", "@id": "ldp:hasMemberRelation"},
				"membershipResource": {"@type": "@id", "@id": "ldp:membershipResource"},
				"membershipResourceTemplate":  {"@id": "ldpt:membershipResource"},
				"insertedContentRelation": {"@type": "@id", "@id": "ldp:insertedContentRelation"},
				"subResourceRelation": {"@type": "@id"},
				"subResourceOf": {"@type": "@id"},
				"expectedType": {"@type": "@id", "@id": "expects"},
				"subClassOf": {"@type": "@id", "@id": "rdfs:subClassOf"},
				"storageType": {"@type": "@id"}
			},

		"@type": "Package",
		"membershipResource": {"@embed": false},
		"subClassOf": {"@embed": false},
		"expects": {"@embed": false},
		"subResourceOf": {"@embed": false},
		"pathTemplate": "",
		"hasSubResource": {"@type": "Package", "@embed": true}
		}
	);


	var rootPackage = this.rootPackage = this.getPackage(rootPackageId);

	if(!rootPackage){
		throw new Error("Root Package Not Found! " + rootPackageId);
	}

	debug("root package", rootPackage);

	var self = this;

	function addTypeMaps(pkg, base){

		var pathTemplate = pkg.pathTemplate;

		if(pkg.hasSubResource){
			if(!pkg.hasSubResource.length){
				pkg.hasSubResource = [pkg.hasSubResource];
			}

			for(var i=0; i < pkg.hasSubResource.length; i++){
				if(pkg.hasSubResource[i]["@id"] == pkg["@id"]){
					debug("Recursion detected changing path ...", pkg["@id"]);
					var tail = pkg.pathTemplate[pkg.pathTemplate.length - 1] == "/" ? "/" : "";
					pathTemplate = "(" + pkg.pathTemplate + tail + "/?)+" + tail;
					break;
				}
			}

		}

		var path = joinPath(base || "/", pathTemplate || "");

		if(pkg.hasSubResource){
			for(var i = 0; i < pkg.hasSubResource.length; i++){
				pkg.hasSubResource[i] = self.getPackage(pkg.hasSubResource[i]["@id"]);
				if(pkg.hasSubResource[i]["@id"] == pkg["@id"]){
					debug("Recursion detected, ignoring ...", pkg["@id"]);
				}else{
					addTypeMaps(self.getPackage(pkg.hasSubResource[i]["@id"]), path);
				}
			}
		}
		if(~path.indexOf("{slug}")){
			self.typeMaps.push({regex: new RegExp("^" + path.replace(/{slug}/g, "([^/]+)") + "$"), type: pkg["@id"]});
		}else{
			self.typeMaps.unshift({regex: new RegExp("^" + path.replace(/{slug}/g, "([^/]+)") + "$"), type: pkg["@id"]});
		}

		// self.typeMaps.push({regex: new RegExp("^" + path + (~pkg["@type"].indexOf('ldpt:Container') ? "/$" : "$")), type: pkg["@id"]});

	}

	addTypeMaps(rootPackage);
	debug("Type Maps: ", this.typeMaps);

});

Application$.getPackage = function(id){
	assert(typeof id == "string", "Package ID must be a string, provided: " + id)
	var r = false, id = this.ns.resolve(id);
	for(var i=0; i< this.packages["@graph"].length; i++){
		if(id == this.packages["@graph"][i]["@id"]){
			r = this.packages["@graph"][i];
			break;
		}
	}
	return r;
}

Application$.configure = function(configurator){
	if(configurator){
		this._configurators.push(configurator)
	}else{
		debug("running configurators", this._configurators)
		for(var i = 0; i < this._configurators.length; i++){
			this._configurators[i].apply(this);
		}
	}
}

var Interceptor = require('rest/interceptor');

var HTTP = function(app){
	this.app = app;
	this.Resource = app.type("ldp:Resource");
	this.interceptors = [];
}

HTTP.prototype = {
	request: function(req){
		if(!req.entity) delete req.entity;
		req.mime = req.entity ? (req.mime || "application/json") : "text/plain";
		req.path = this.app.ns.resolve(encodeURI(req.path));

		if(this.app.env.accessHost){
			var rx = new RegExp("^"+this.app.env.host);
			req.path = req.path.replace(rx, this.app.env.accessHost);
		}

		if(!req.headers) req.headers = {};
		var Resource = this.Resource;
		//
		// req.headers["Accept-Charset"] = req.headers["Accept-Charset"] || "utf-8";
		// req.headers["Accept"] = req.headers["Accept"] || "application/ld+json,application/json";
		// req.headers["Content-Type"] = req.headers["Content-Type"] || "application/json;charset=UTF-8";

		var client = rest;
		for (var i = 0; i < this.interceptors.length; i++){
			debug("using interceptor", this.interceptors[i] )
			client = client.wrap(Interceptor(this.interceptors[i]));
		}
		return client
		.wrap(require("rest/interceptor/mime"), {accept: "application/ld+json,application/json", mime: req.mime})
		.wrap(locationInterceptor)
		.wrap(require('rest/interceptor/errorCode'))
		.wrap(Interceptor({
			response: function (response) {
				if(!response.headers){
					debug("Response has no headers!", response)
					return response;
				}
				if(response.headers["Content-Type"] == "application/ld+json"){
					response.entity = new Resource(response.entity);
					debug("HTTP Result Response is JSON-LD")
				}
				return response;
			}
		}))
		.wrap(require('rest/interceptor/entity'))
		(req)
		.catch(function(e){
			throw new Error("HTTP Client Error: (" + e.status + ") ["+ req.path+"]"+ (e.message || JSON.stringify(e)));
		});
	},
	post: function(url, data){
		return this.request({path: url, entity: data, method: "POST"});
	},
	get: function(url, data){
		return this.request({path: url, entity: data, method: "GET"});
	},
	put: function(url, data){
		return this.request({path: url, entity: data, method: "PUT"});
	},
	patch: function(url, data){
		return this.request({path: url, entity: data, method: "PATCH"});
	},
	delete: function(url, data){
		return this.request({path: url, entity: data, method: "DELETE"});
	}
}

methods.forEach(function(m){
	Application$[m] = function(type, handler){
		var r;
		if(r = this.routes[m][this.ns.resolve(type)]){
			r.push(handler);
		}else{
			this.routes[m][this.ns.resolve(type)] = [handler];
		};
	}
});
