module.exports = function(app){
	app.type("owl:Thing")
		.frame({
			"@context": {
				owl: "http://www.w3.org/2002/07/owl#",
				rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
			}
		});
}