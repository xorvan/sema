var utile = require("utile")
	, methods = require("./methods")
	, Q = require("q")
	, co = require("co")
	, thunkify = require("thunkify")
	, uuid = require("node-uuid")
	, joinPath = require("./joinPath.js")
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
		console.log("registering slugger", this.id, slugger)
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
	// console.log("identify", resource, this.id)
	var basePackage = this.basePackage;
	if(!basePackage){
		throw new Error("No Base Package found for " + this.id+"! identifying "+ JSON.stringify(resource));
	}

	var T = this.app.type(basePackage["@id"])
		id = "";


	// console.log("basepkg", T.slugger, id)
	if(!basePackage.subResourceOf){
		throw new Error(basePackage["@id"] + " is subResource of nothing!")
	}else{
		// console.log("basePackage.subResourceOf", basePackage.subResourceOf)
		var np, p = this.app.type(basePackage.subResourceOf).package;
		while(p && p["@id"] != this.app.rootPackage["@id"]){
			// console.log("idddddd11", id, p)
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


		// console.log("idddddd", id)

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

function getBaseType(app, pkg){
	if(pkg.pathTemplate) return pkg;

	var packages = pkg["subClassOf"];

	if(!packages)
		return pkg;

	for(var i = 1; i <= packages.length; i++){
		// console.log("ppppp", packages[i])
		var pkg = app.getPackage(packages[i]);
		if(pkg.pathTemplate) return pkg;
	}
	return app.rootPackage;
}

function getSlugType(app, type){
	console.log("st", type.id, type.hasSlugger)
	if(type.hasSlugger) return type;

	var packages = type.package["subClassOf"];

	if(!packages)
		return type;

	for(var i = 1; i <= packages.length; i++){
		// console.log("ppppp", packages[i])
		var superType = app.type(packages[i]);
		console.log("st", superType.id, superType.hasSlugger)
		if(superType.hasSlugger) return superType;
	}
	return type;
}


TypeWrapper$.__defineGetter__("basePackage", function(){
	return getBaseType(this.app, this.package)
})


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
