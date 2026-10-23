/**
 * For each category, add dependencies for fields.
 * Structure:
 * categoryName: {
 *     fieldName1: corespondingDependentFunctionDefinedByDataTable1,
 *     fieldName2: corespondingDependentFunctionDefinedByDataTable2,
 *     ...
 * }
 * Which will be called in dataTable.api.editor.js.
 */
 
 var WebEditorDeps = {
	 link: {
		 'useSocialMediaOriColor': function( val, data, callback, e ) {
			 if (val === '0') {
				 return {
					 show: 'bgColor'
				 };
			 } else {
				 return {
					 hide: 'bgColor',
					 values: {
						 'bgColor': ''
					 } 
				 };
			 }
		 }
	 }
 }