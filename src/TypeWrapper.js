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
		throw new Error(basePackage["@id"] + " is subResource of different things! " + sr)
	}else{
		var np, p = this.app.type(basePackage.subResourceOf).package;
		while(p && p["@id"] != this.app.rootPackage["@id"]){
			p = this.app.type(getBaseType(this.app, p )["@id"]).package;

			//TODO: check container template container resource template with occured {slug}

			if(p.containerResourceTemplate){
				np = p;
			}

			if(p.pathTemplate == "{slug}"){
				if(np){
					// console.log("slug is reached", id, resource, np.containedByRelation)
					if(!resource[np.isMemberOfRelation]){
						throw new Error("isMemberOfRelation, " + np.isMemberOfRelation + " ,not found to identify " + JSON.stringify(resource))
					}
					id = joinPath(resource[np.isMemberOfRelation]["@id"], id)
					p = false;
				}else{
					throw new Error("No Container Template found to identify " + JSON.stringify(p))
				}
			}else{
				id = joinPath(p.pathTemplate, id)
				p = this.app.type(p.subResourceOf).package;
			}
		}

		if(basePackage.pathTemplate == "{slug}"){
			var ST = getSlugType(this.app, T);
			console.log("slug type is", ST.id)
			var slugger = ST.slug(resource, proposed);
			do{
				var slug = slugger.next();
				var r = "/" + joinPath(id, slug.value);
				var found = yield app.db.query("ASK {?id ?s ?p}", {id: r.iri()});
				console.log("found", found, slug)
			}while(found)
			return r;
		}else{
			return "/" + joinPath(id, basePackage.pathTemplate);
		}
	}

}))

TypeWrapper$.type = function(){
	if(this._types){
		return Q(this._types);
	}
	var deferred = Q.defer();
	co(function *(){
		var types = this._types = (yield this.app.db.query("select ?t (count(?m) as ?d) where {?p rdfs:subClassOf ?m. ?m rdfs:subClassOf ?t.} group by ?t order by asc(?d)", {p:this.id.iri()}))
			.map(function(t){return t.t.value});
		return types;
	}).call(this, deferred.makeNodeResolver());
	return deferred.promise;
}

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

	for(var i = 1; i <= packages.length; i++){
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
