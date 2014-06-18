var koa = require("koa")
	, utile = require('utile')
	, url = require('url')
	, path = require('path')
	, jsonld = require("jsonld").promises()
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
;


var defaultEnv = {
	sparqlEndpoint: "http://localhost:5820/test/query"
	, graphStoreEndpoint: "http://localhost:5820/test"
	, cookieSecret: "Hermes is the God of Technology!"
	, host: "localhost:4000"
}

require("rest/mime/registry").register("application/ld+json", require("rest/mime/type/application/json"));

var locationInterceptor = require("rest/interceptor")({
	success: function (response, config, client) {
		if (response.headers && response.headers.Location) {
			return (config.client || (response.request && response.request.originator) || client.skip())({
				method: 'GET',
				path: url.resolve(response.request.path, response.headers.Location)
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
	this.ns.base = utile.format("http://%s", this.env.host);

	this.ns.register("sema", "http://www.xorvan.com/ns/sema#");


	//Loading Ontology
	if(typeof ontology == "string"){
		this.ontology = fs.readFileSync(ontology, "utf8");
	}else{
		this.ontology = ontology;
	}

	this.typeMaps = [];
	this.framings = {};
	this._types = {};
	this._modules = [];

	this.http = new HTTP(this);


	//authorization middleware
	this.use(function *(next){
		if(this.header["x-sema-secret"] && this.header["x-sema-secret"] == systemSecret){
			this.agent = {id:"sema-system"};
		}else if(this.header.authorization){
			var auth = this.header.authorization.split(' ');
			if(auth.length > 1 && auth[0] == "Bearer"){
				var token = auth[1];
				var agent = yield this.app.db.query("select ?agent {?tk a h:Token; rdf:value ?hash. ?tk h:issuedFor ?agent}", {hash: token.lit()})
				if(agent.length){
					this.agent = agent[0].agent.value;
					console.log("########## this agent ", this.agent)
				}
			}
		}

		yield next;
	});

}

var Application$ = Application.prototype;

Application$.__proto__ = utile.mixin(koa.prototype, EventEmitter2.prototype);

Application$.use = function(mw){
	if(typeof mw == "object" && mw instanceof Application){
		console.log("Using Sema Application ...");
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
				// console.log("importing slugger", tid)
				dt.slug(t.slugger);
			}

			if(t.hasFrame){
				dt.frame(t.frame())
			}
		}


		// console.log("ROUTES", JSON.stringify(this.routes.get), JSON.stringify(mw.routes.get))
	}else{
		return koa.prototype.use.call(this, mw);
	}
}

Application$.type = function(id){
	var id = this.ns.resolve(id), self = this;
	// console.log("resolving",id)
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
		for(var i = 0; i < types.length; i++){
			var t, c, r;
			if( t = this.framings[types[i]]){
				r = utile.mixin(utile.clone(f), t);
				if(f["@context"]){
					r["@context"] = utile.mixin(utile.clone(f["@context"]), t["@context"]);
				}
				f = r;
			}
		}
	}
	if(!f["@context"])
		f["@context"] = {};

	return f;
}

Application$.init = co(function *(rootPackageId){

	//Installing Body Parser
	bodyParser(this);

	//Installing middlewares
	// this.use(require("koa-error")());
	this.use(function *(next){
		// console.log("received body", this.body)
		//User
		// console.log("HEADERRRRR ", this.header);

		// this.agent = {id:"http://localhost:4001/people/Naghi_ShaNaghi"};
		//Package Finder
		for(var i = 0; i < self.typeMaps.length; i++){
			var pkg = this.app.typeMaps[i];
			if(pkg.regex.test(this.path)){
				this.rdf = {};
				this.rdf.Type = self.type(pkg.type);
				this.rdf.type = yield this.rdf.Type.type();
				// console.log("rdf types", this.rdf.type);
				break;
			}
		}
		yield next;
	})
	this.use(function *(next){
		if(!this.rdf){
			return next;
		}
		//Router
		var types = this.rdf.type, routes = self.routes[this.method.toLowerCase()], mw = [];
		for(var i = types.length -1 ; i >= 0; i--){
			var t;
			if(t = routes[types[i]]) mw = mw.concat(t);
		}
		// console.log("routes ", mw);
		if(mw.length){
			yield compose(mw.concat(function *(){yield next}));
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

			console.log("Ontology is \n", ontology);

			if(fs.existsSync(".loadedOntology.ttl")){
				var prevOntology = fs.readFileSync(".loadedOntology.ttl");

				if( prevOntology == ontology){
					console.log("Ontology is the same!")
				}else{
					console.log("Ontology has been changed!", prevOntology);
					fs.writeFileSync(".loadedOntology.ttl", ontology);

					var res = yield this.db.update("DELETE WHERE{ ?prevOntology } ; INSERT DATA{ ?ontology }", {prevOntology:prevOntology.toString().replace(/_:b/g, "?b"), ontology: ontology});
					console.log("Ontology has been pushed to DB!", res)
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
		ddd = yield this.db.query("describe ?s {?s a sema:Package . hint:Query hint:describeMode \"CBD\"}")
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
				"subClassOf": {"@type": "@id", "@id": "rdfs:subClassOf"}
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
// console.log(ddd, packages)
	var rootPackage = this.rootPackage = this.getPackage(rootPackageId);

	if(!rootPackage){
		throw new Error("Root Package Not Found! " + rootPackageId);
	}

	// console.log("root package", rootPackage);

	var self = this;

	function addTypeMaps(pkg, base){

		var pathTemplate = pkg.pathTemplate;

		if(pkg.hasSubResource){
			if(!pkg.hasSubResource.length){
				pkg.hasSubResource = [pkg.hasSubResource];
			}

			for(var i=0; i < pkg.hasSubResource.length; i++){
				if(pkg.hasSubResource[i]["@id"] == pkg["@id"]){
					console.log("Recursion detected changing path ...", pkg["@id"]);
					pathTemplate = "(" + pkg.pathTemplate + "/?)*";
					break;
				}
			}

		}

		var path = joinPath(base || "/", pathTemplate || "").replace(/{slug}/g, "([^/]+)");

		if(pkg.hasSubResource){
			for(var i = 0; i < pkg.hasSubResource.length; i++){
				if(pkg.hasSubResource[i]["@id"] == pkg["@id"]){
					console.log("Recursion detected, ignoring ...", pkg["@id"]);
				}else{
					addTypeMaps(self.getPackage(pkg.hasSubResource[i]["@id"]), path);
				}
			}
		}
		self.typeMaps.push({regex: new RegExp("^" + path + "$"), type: pkg["@id"]});
		// self.typeMaps.push({regex: new RegExp("^" + path + (~pkg["@type"].indexOf('ldpt:Container') ? "/$" : "$")), type: pkg["@id"]});

	}

	addTypeMaps(rootPackage);
	// console.log(this.typeMaps);

});

Application$.getPackage = function(id){
	var r = false, id = this.ns.resolve(id);
	for(var i=0; i< this.packages["@graph"].length; i++){
		if(id == this.packages["@graph"][i]["@id"]){
			r = this.packages["@graph"][i];
			break;
		}
	}
	return r;
}



var HTTP = function(app){
	this.app = app;
}
var systemSecret = "this is top secret string that should be kept hidden"
HTTP.prototype = {
	request: function(req){
		req.mime = req.mime || "application/json";
		req.path = this.app.ns.resolve(req.path);
		if(!req.headers) req.headers = {};
		//
		// req.headers["Accept-Charset"] = req.headers["Accept-Charset"] || "utf-8";
		// req.headers["Accept"] = req.headers["Accept"] || "application/ld+json,application/json";
		// req.headers["Content-Type"] = req.headers["Content-Type"] || "application/json;charset=UTF-8";
		req.headers["x-sema-secret"] = systemSecret;
		console.log("req", req);
		return rest
		.wrap(require("rest/interceptor/mime"), {accept: "application/ld+json,application/json", mime: req.mime})
		.wrap(locationInterceptor)
		.wrap(require('rest/interceptor/errorCode'))
		.wrap(require('rest/interceptor/entity'))
		(req);
	},
	post: function(url, data){
			console.log("posting....")
		try{
			var r = this.request({path: url, entity: data, method: "POST"});
			console.log("req is ", r)
			return r
		}catch(e){
			console.log("post error", e)
		}
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
