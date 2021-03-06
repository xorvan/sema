var utile = require("utile")
	, debug = require("debug")("sema:TypeWrapper")
	, methods = require("./methods")
	, Q = require("q")
	, co = require("co")
	, thunkify = require("thunkify")
	, jsonld = require("jsonld").promises()
	, uuid = require("node-uuid")
	, joinPath = require("./joinPath.js")
	, assert = require("assert")
	, url = require("url")
;

var TypeWrapper = module.exports = function TypeWrapper(id, app){
	this.id = id;
	this.app = app;
}

var TypeWrapper$ = TypeWrapper.prototype;

TypeWrapper$.frame = function(framing){
	var id = this.app.ns.resolve(this.id);
	if(!framing){
		return this.app.framings[id] || {};
	}else{
		assert(typeof framing == "object", "Frame must be object not" + (typeof framing) + "for "+ this.id);
		var p;
		this.hasFrame = true;
		if(p = this.app.framings[id]){
			var f = utile.clone(framing), c;
			if(f["@context"]){
				this.app.framings[id]["@context"] = utile.mixin(this.app.framings[id]["@context"], f["@context"]);
				delete f["@context"];
			}
			this.app.framings[id] = utile.mixin(this.app.framings[id], f);
		}else{
			this.app.framings[id] = framing;
		}
		return this;
	}
}

TypeWrapper$.slug = function(slugger, proposed){
	if(typeof slugger == "function"){
		this._slugger = slugger;
		this.hasSlugger = true;
		return this;
	}else{
		return this.slugger(slugger, proposed);
	}
}

TypeWrapper$.slugger = function *(resource, proposed){
	if(this._slugger){
		var slug = this._slugger.call(resource, proposed);
		if(slug.next){
			yield* slug;
		}else{
			yield slug;
			for(var i=0; i< 10; i++)
				yield slug + "_" + ~~(Math.random() * 100000);
		}
	}else if(proposed){
		yield proposed;
	}

	return uuid.v4();
}

TypeWrapper$.identify = thunkify(co(function *(resource, proposed){
	debug("Identify %s", this.id, resource)
	var basePackage = this.basePackage;
	if(!basePackage){
		throw new Error("No Base Package found for " + this.id+"! identifying "+ JSON.stringify(resource));
	}

	var T = this.app.type(basePackage["@id"])
		id = "";

	var sr = basePackage.subResourceOf

	if(!sr){
		throw new Error(basePackage["@id"] + " is subResource of nothing!")
	}else if(typeof sr === "object" && sr.length > 1){

		if(~sr.indexOf(basePackage["@id"])){
			debug("Recursive Type detected", basePackage["@id"]);
			id = resource["@id"] ? url.resolve(resource["@id"], "./") : "./";
		}else{
			throw new Error(basePackage["@id"] + " is subResource of different things! " + sr)
		}
	}else{
		var np, p = this.app.type(basePackage.subResourceOf).package;
		while(p && p["@id"] != this.app.rootPackage["@id"]){
			console.log("checking...", p["@id"], np && np["@id"], id)
			p = this.app.type(getBaseType(this.app, p )["@id"]).package;

			//TODO: check container template container resource template with occured {slug}

			console.log("mrt", p.membershipResourceTemplate)
			if(p.membershipResourceTemplate && p.membershipResourceTemplate.indexOf("..") == 0){
				np = p;
			}

			if(~p.pathTemplate.indexOf("{slug}")){
				if(np){
					var moRel = np.isMemberOfRelation == "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" ? "@type" : np.isMemberOfRelation;
					// console.log("slug is reached", id, resource, np.containedByRelation)
					if(!resource[moRel]){
						console.log("p", p);
						console.log("np", np);
						throw new Error("isMemberOfRelation, " + moRel + ", not found to identify " + JSON.stringify(resource))
					}
					var relRes = resource[moRel]["@id"] || resource[moRel];
					if(typeof relRes == "object"){
						var relRess = relRes;
						relRes = false;
						for(var i = 0; i < relRess.length ; i++){
							console.log("checking", i, relRess[i], this.app.ns.base)
							if(relRess[i].indexOf(this.app.ns.base) == 0){
								relRes = relRess[i];
								break;
							}
						}
						if(!relRes){
							throw new Error("No appropriate relation find for package " + p["@id"]+" : " + JSON.stringify(p.subResourceOf) + ", current id:" + id)
						}
					}
					debug("joining", relRes, id)
					id = joinPath(relRes, id)
					p = false;
				}else{
					throw new Error("No Container Template found to identify " + JSON.stringify(p))
				}
			}else{
				id = joinPath(p.pathTemplate, id)
				if(typeof p.subResourceOf != "string"){
					throw new Error("Invalid subResourceOf for package " + p["@id"]+" : " + JSON.stringify(p.subResourceOf) + ", current id:" + id)
				}
				p = this.app.type(p.subResourceOf).package;
			}
		}
	}

	var id = url.parse(id).path;
	if(id[0] != "/") id = "/" + id;

	if(~basePackage.pathTemplate.indexOf("{slug}") ){
		var ST = getSlugType(this.app, T);
		debug("slug type is", ST.id)
		var slugger = ST.slug(resource, proposed);
		do{
			var slug = slugger.next();
			var slugValue = basePackage.pathTemplate.replace("{slug}", slug.value);
			debug("joining slug ", id, slugValue)
			var r = joinPath(id, slugValue);
			debug("final id", id, slugValue)
			var found = yield this.app.db.query("ASK {?id ?s ?p}", {id: r.iri()});
			debug("found", found, slug)
		}while(found)
		return r;
	}else{
		return joinPath(id, basePackage.pathTemplate);
	}

}))

TypeWrapper$.type = thunkify(co(function *(){
	if(this._types){
		return this._types;
	}

	var types = this._types = (yield this.app.db.query("select ?t (count(?m) as ?d) where {?p rdfs:subClassOf ?m. ?m rdfs:subClassOf ?t.} group by ?t order by asc(?d)", {p:this.id.iri()}))
		.map(function(t){return t.t.value});

	return types;
}));

function toArray(){
	var context = this["@context"];
	return this["@set"].map(function(item){
		if(context) item["@context"] = context;
		return item
	});
}

TypeWrapper$.query = thunkify(co(function *(qs, bindings){
	var res = yield this.app.db.query(qs, bindings);
	var types = yield this.type();
	var frame = this.app.getFrame(types)
	frame["@type"] = this.id;
	var framed = yield jsonld.frame(res, frame);
	framed["@set"] = framed["@graph"];
	delete framed["@graph"];
	// framed.$toArray = toArray.bind(framed);
	return framed;
}))

function getBaseType(app, pkg){
	if(pkg.pathTemplate) return pkg;

	var packages = pkg["subClassOf"];

	if(!packages)
		return pkg;

	for(var i = 0; i < packages.length; i++){
		var pkg = app.getPackage(packages[i]);
		if(pkg.pathTemplate) return pkg;
	}
	return app.rootPackage;
}

function getSlugType(app, type){
	debug("Finding Slugger Type for %s %s", type.id, type.hasSlugger)
	if(type.hasSlugger) return type;

	var packages = type.package["subClassOf"];

	if(!packages)
		return type;

	debug("Super types", packages)
	for(var i = 0; i < packages.length; i++){
		var superType = app.type(packages[i]);
		if(superType.hasSlugger) return superType;
	}
	return type;
}


TypeWrapper$.__defineGetter__("basePackage", function(){
	return getBaseType(this.app, this.package)
})

TypeWrapper$.all = function(handler){
	var self = this;
	methods.forEach(function(m){
		self[m](handler);
	});
	return this;
};

methods.forEach(function(m){
	TypeWrapper$[m] = function(handler){
		var id = this.app.ns.resolve(this.id);
		if(this.app.routes[m][id]){
			this.app.routes[m][id].push(handler);
		}else{
			this.app.routes[m][id] = [handler];
		}
		return this;
	}
});
