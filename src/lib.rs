mod utils;

use std::collections::{BTreeMap, BTreeSet};

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    BindingPattern, Class, Declaration, ExportAllDeclaration, ExportDefaultDeclaration,
    ExportDefaultDeclarationKind, ExportNamedDeclaration, Function, ImportDeclaration,
    ImportDeclarationSpecifier, ImportExpression, MetaProperty, ModuleExportName, Program,
    Statement, VariableDeclaration,
};
use oxc_ast_visit::{Visit, walk};
use oxc_parser::{ParseOptions, Parser};
use oxc_semantic::{Semantic, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, SourceType, Span};
use serde::Serialize;
use wasm_bindgen::prelude::*;

const GARFISH_IMPORT: &str = "__GARFISH_IMPORT__";
const GARFISH_EXPORT: &str = "__GARFISH_EXPORT__";
const GARFISH_DEFAULT: &str = "__GARFISH_DEFAULT__";
const GARFISH_NAMESPACE: &str = "__GARFISH_NAMESPACE__";
const GARFISH_IMPORT_META: &str = "__GARFISH_IMPORT_META__";
const GARFISH_DYNAMIC_IMPORT: &str = "__GARFISH_DYNAMIC_IMPORT__";
const GARFISH_DEFAULT_IMPORT: &str = "__GARFISH_DEFAULT_IMPORT__";
const GARFISH_EXPORT_STAR: &str = "__GARFISH_EXPORT_STAR__";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportInfo {
    module_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransformResult {
    code: String,
    imports: Vec<ImportInfo>,
    exports: Vec<String>,
}

struct Replacement {
    start: usize,
    end: usize,
    text: String,
}

struct ExportGetter {
    name: String,
    expression: String,
}

struct ExportStarGetter {
    module_name: String,
}

struct Transformer<'a> {
    source: &'a str,
    filename: &'a str,
    semantic: &'a Semantic<'a>,
    imports: Vec<ImportInfo>,
    replacements: Vec<Replacement>,
    export_getters: Vec<ExportGetter>,
    export_star_getters: Vec<ExportStarGetter>,
    import_live_bindings: BTreeMap<SymbolId, String>,
    import_live_bindings_by_name: BTreeMap<String, String>,
    module_count: usize,
}

#[wasm_bindgen(start)]
pub fn start() {
    utils::set_panic_hook();
}

#[wasm_bindgen]
pub fn transform(source: &str, filename: &str) -> Result<JsValue, JsValue> {
    utils::set_panic_hook();

    let result =
        transform_to_result(source, filename).map_err(|error| JsValue::from_str(&error))?;
    serde_wasm_bindgen::to_value(&result).map_err(|error| JsValue::from_str(&error.to_string()))
}

fn transform_to_result(source: &str, filename: &str) -> Result<TransformResult, String> {
    let allocator = Allocator::default();
    let source_type = source_type_for(filename);
    let parsed = Parser::new(&allocator, source, source_type)
        .with_options(ParseOptions {
            parse_regular_expression: true,
            ..ParseOptions::default()
        })
        .parse();

    if !parsed.diagnostics.is_empty() {
        let message = parsed
            .diagnostics
            .into_iter()
            .map(|diagnostic| format!("{diagnostic:?}"))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!("Failed to parse {filename}: {message}"));
    }

    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&parsed.program)
        .semantic;
    Transformer::new(source, filename, &semantic).transform(&parsed.program)
}

impl<'a> Transformer<'a> {
    fn new(source: &'a str, filename: &'a str, semantic: &'a Semantic<'a>) -> Self {
        Self {
            source,
            filename,
            semantic,
            imports: Vec::new(),
            replacements: Vec::new(),
            export_getters: Vec::new(),
            export_star_getters: Vec::new(),
            import_live_bindings: BTreeMap::new(),
            import_live_bindings_by_name: BTreeMap::new(),
            module_count: 0,
        }
    }

    fn transform(mut self, program: &Program<'a>) -> Result<TransformResult, String> {
        for statement in &program.body {
            self.transform_statement(statement)?;
        }

        self.transform_import_live_binding_references(program);

        let mut expression_collector = ExpressionCollector::default();
        expression_collector.visit_program(program);
        for span in expression_collector.import_meta_spans {
            self.add_replacement(span, format!("{GARFISH_IMPORT_META}.meta"));
        }
        for span in expression_collector.dynamic_import_spans {
            self.replacements.push(Replacement {
                start: span.start as usize,
                end: span.start as usize + "import".len(),
                text: GARFISH_DYNAMIC_IMPORT.to_string(),
            });
        }

        let code = apply_replacements(self.source, &self.replacements)
            .map_err(|message| format!("{} ({})", message, self.filename))?;
        let (export_code, exports) = self.generate_export_code();

        Ok(TransformResult {
            code: format!("{code}{export_code}"),
            imports: dedupe_imports(self.imports),
            exports,
        })
    }

    fn transform_statement(&mut self, statement: &Statement<'a>) -> Result<(), String> {
        match statement {
            Statement::ImportDeclaration(declaration) => {
                self.transform_import_declaration(declaration);
            }
            Statement::ExportNamedDeclaration(declaration) => {
                self.transform_export_named_declaration(declaration)?;
            }
            Statement::ExportAllDeclaration(declaration) => {
                self.transform_export_all_declaration(declaration);
            }
            Statement::ExportDefaultDeclaration(declaration) => {
                self.transform_export_default_declaration(declaration)?;
            }
            _ => {}
        }

        Ok(())
    }

    fn transform_import_declaration(&mut self, declaration: &ImportDeclaration<'a>) {
        let module_id = declaration.source.value.to_string();
        self.imports.push(ImportInfo {
            module_id: module_id.clone(),
        });

        let module_name = self.next_module_name();
        let mut lines = vec![format!(
            "const {module_name} = {GARFISH_IMPORT}({});",
            string_literal(&module_id),
        )];

        if let Some(specifiers) = &declaration.specifiers {
            if specifiers.is_empty() {
                lines.clear();
                lines.push(format!("{GARFISH_IMPORT}({});", string_literal(&module_id)));
            } else {
                for specifier in specifiers {
                    if let Some(binding) = import_binding(specifier, &module_name) {
                        if let Some(symbol_id) = binding.symbol_id {
                            self.import_live_bindings
                                .insert(symbol_id, binding.live_expression.clone());
                            self.import_live_bindings_by_name.insert(
                                binding.local_name.clone(),
                                binding.live_expression.clone(),
                            );
                        }
                        lines.push(binding.declaration_code);
                    } else {
                        lines.push(import_namespace_binding_code(specifier, &module_name));
                    }
                }
            }
        } else {
            lines.clear();
            lines.push(format!("{GARFISH_IMPORT}({});", string_literal(&module_id)));
        }

        self.add_statement_replacement(declaration.span, lines.join("\n"));
    }

    fn transform_export_named_declaration(
        &mut self,
        declaration: &ExportNamedDeclaration<'a>,
    ) -> Result<(), String> {
        if let Some(source) = &declaration.source {
            let module_id = source.value.to_string();
            self.imports.push(ImportInfo {
                module_id: module_id.clone(),
            });
            let module_name = self.next_module_name();
            self.add_statement_replacement(
                declaration.span,
                format!(
                    "const {module_name} = {GARFISH_IMPORT}({});",
                    string_literal(&module_id),
                ),
            );

            for specifier in &declaration.specifiers {
                self.add_export(
                    module_export_name(&specifier.exported),
                    format!(
                        "{module_name}{}",
                        property_access(&module_export_name(&specifier.local)),
                    ),
                );
            }
            return Ok(());
        }

        if let Some(declaration_node) = &declaration.declaration {
            let names = declaration_binding_names(declaration_node);
            for name in names {
                self.add_export(name.clone(), name);
            }
            self.add_prefix_replacement(declaration.span, declaration_node.span(), String::new());
            return Ok(());
        }

        for specifier in &declaration.specifiers {
            let local_name = module_export_name(&specifier.local);
            self.add_export(
                module_export_name(&specifier.exported),
                self.import_live_bindings_by_name
                    .get(&local_name)
                    .cloned()
                    .unwrap_or(local_name),
            );
        }
        self.add_statement_replacement(declaration.span, String::new());
        Ok(())
    }

    fn transform_export_all_declaration(&mut self, declaration: &ExportAllDeclaration<'a>) {
        let module_id = declaration.source.value.to_string();
        self.imports.push(ImportInfo {
            module_id: module_id.clone(),
        });
        let module_name = self.next_module_name();
        self.add_statement_replacement(
            declaration.span,
            format!(
                "const {module_name} = {GARFISH_IMPORT}({});",
                string_literal(&module_id),
            ),
        );

        if let Some(exported) = &declaration.exported {
            self.add_export(
                module_export_name(exported),
                format!("{GARFISH_NAMESPACE}({module_name})"),
            );
        } else {
            self.export_star_getters
                .push(ExportStarGetter { module_name });
        }
    }

    fn transform_export_default_declaration(
        &mut self,
        declaration: &ExportDefaultDeclaration<'a>,
    ) -> Result<(), String> {
        match &declaration.declaration {
            ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                self.transform_default_function_or_class(
                    declaration.span,
                    function.span,
                    function.id.as_ref(),
                )?;
            }
            ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                self.transform_default_function_or_class(
                    declaration.span,
                    class.span,
                    class.id.as_ref(),
                )?;
            }
            _ => {
                self.add_prefix_replacement(
                    declaration.span,
                    declaration.declaration.span(),
                    format!("const {GARFISH_DEFAULT} = "),
                );
                self.add_export("default".to_string(), GARFISH_DEFAULT.to_string());
            }
        }

        Ok(())
    }

    fn transform_default_function_or_class(
        &mut self,
        span: Span,
        declaration_span: Span,
        id: Option<&oxc_ast::ast::BindingIdentifier<'a>>,
    ) -> Result<(), String> {
        if let Some(id) = id {
            let name = id.name.to_string();
            self.add_prefix_replacement(span, declaration_span, String::new());
            self.add_export("default".to_string(), name);
        } else {
            self.add_prefix_replacement(
                span,
                declaration_span,
                format!("const {GARFISH_DEFAULT} = "),
            );
            self.add_export("default".to_string(), GARFISH_DEFAULT.to_string());
        }
        Ok(())
    }

    fn next_module_name(&mut self) -> String {
        let name = format!("__m{}__", self.module_count);
        self.module_count += 1;
        name
    }

    fn add_statement_replacement(&mut self, span: Span, text: String) {
        self.replacements.push(Replacement {
            start: span.start as usize,
            end: span.end as usize,
            text,
        });
    }

    fn add_prefix_replacement(&mut self, outer_span: Span, inner_span: Span, text: String) {
        self.replacements.push(Replacement {
            start: outer_span.start as usize,
            end: inner_span.start as usize,
            text,
        });
    }

    fn add_replacement(&mut self, span: Span, text: String) {
        self.replacements.push(Replacement {
            start: span.start as usize,
            end: span.end as usize,
            text,
        });
    }

    fn add_export(&mut self, name: String, expression: String) {
        self.export_getters.push(ExportGetter { name, expression });
    }

    fn transform_import_live_binding_references(&mut self, program: &Program<'a>) {
        if self.import_live_bindings.is_empty() {
            return;
        }

        let replaced_source_ranges = self
            .replacements
            .iter()
            .filter(|replacement| replacement.start < replacement.end)
            .map(|replacement| (replacement.start, replacement.end))
            .collect::<Vec<_>>();

        let mut shorthand_collector = ImportShorthandCollector {
            semantic: self.semantic,
            import_live_bindings: &self.import_live_bindings,
            replacements: Vec::new(),
            covered_reference_spans: BTreeSet::new(),
        };
        shorthand_collector.visit_program(program);
        let covered_reference_spans = shorthand_collector.covered_reference_spans;
        self.replacements.extend(shorthand_collector.replacements);

        for (symbol_id, expression) in &self.import_live_bindings {
            for reference in self.semantic.symbol_references(*symbol_id) {
                if !reference.is_read() || reference.is_write() {
                    continue;
                }

                let span = self.semantic.reference_span(reference);
                if span_is_inside_ranges(span, &replaced_source_ranges) {
                    continue;
                }

                let key = (span.start as usize, span.end as usize);
                if covered_reference_spans.contains(&key) {
                    continue;
                }

                self.replacements.push(Replacement {
                    start: span.start as usize,
                    end: span.end as usize,
                    text: expression.clone(),
                });
            }
        }
    }

    fn generate_export_code(&self) -> (String, Vec<String>) {
        let mut code = String::new();
        let mut exported_names = BTreeSet::new();
        let mut explicit_getters = Vec::new();

        for getter in &self.export_getters {
            exported_names.insert(getter.name.clone());
            explicit_getters.push(getter);
        }

        if !explicit_getters.is_empty() {
            let properties = explicit_getters
                .iter()
                .map(|getter| {
                    format!(
                        "{}: () => {}",
                        string_literal(&getter.name),
                        getter.expression,
                    )
                })
                .collect::<Vec<_>>()
                .join(",\n");
            code.push_str(&format!("\n{GARFISH_EXPORT}({{\n{properties}\n}});"));
        }

        let excludes = {
            let mut names = BTreeSet::from(["default".to_string()]);
            names.extend(exported_names.iter().cloned());
            json_string_array(&names.into_iter().collect::<Vec<_>>())
        };
        for getter in &self.export_star_getters {
            code.push_str(&format!(
                "\n{GARFISH_EXPORT_STAR}({}, {excludes});",
                getter.module_name,
            ));
        }

        (code, exported_names.into_iter().collect())
    }
}

struct ImportBinding {
    local_name: String,
    live_expression: String,
    declaration_code: String,
    symbol_id: Option<SymbolId>,
}

#[derive(Default)]
struct ExpressionCollector {
    import_meta_spans: Vec<Span>,
    dynamic_import_spans: Vec<Span>,
}

impl<'a> Visit<'a> for ExpressionCollector {
    fn visit_meta_property(&mut self, meta_property: &MetaProperty<'a>) {
        if meta_property.meta.name.as_str() == "import"
            && meta_property.property.name.as_str() == "meta"
        {
            self.import_meta_spans.push(meta_property.span);
        }
        walk::walk_meta_property(self, meta_property);
    }

    fn visit_import_expression(&mut self, import_expression: &ImportExpression<'a>) {
        self.dynamic_import_spans.push(import_expression.span);
        walk::walk_import_expression(self, import_expression);
    }
}

struct ImportShorthandCollector<'s, 'a> {
    semantic: &'s Semantic<'a>,
    import_live_bindings: &'s BTreeMap<SymbolId, String>,
    replacements: Vec<Replacement>,
    covered_reference_spans: BTreeSet<(usize, usize)>,
}

impl<'a> Visit<'a> for ImportShorthandCollector<'_, 'a> {
    fn visit_object_property(&mut self, property: &oxc_ast::ast::ObjectProperty<'a>) {
        if property.shorthand {
            if let oxc_ast::ast::Expression::Identifier(identifier) = &property.value {
                if let Some(reference_id) = identifier.reference_id.get() {
                    let reference = self.semantic.scoping().get_reference(reference_id);
                    if reference.is_read() && !reference.is_write() {
                        if let Some(symbol_id) = reference.symbol_id() {
                            if let Some(expression) = self.import_live_bindings.get(&symbol_id) {
                                let start = property.span.start as usize;
                                let end = property.span.end as usize;
                                let key = identifier.name.as_str();
                                self.replacements.push(Replacement {
                                    start,
                                    end,
                                    text: format!("{key}: {expression}"),
                                });
                                self.covered_reference_spans.insert((
                                    identifier.span.start as usize,
                                    identifier.span.end as usize,
                                ));
                                return;
                            }
                        }
                    }
                }
            }
        }

        walk::walk_object_property(self, property);
    }
}

fn source_type_for(filename: &str) -> SourceType {
    SourceType::from_path(filename).unwrap_or_else(|_| SourceType::mjs())
}

fn module_export_name(name: &ModuleExportName) -> String {
    name.name().to_string()
}

fn import_binding(
    specifier: &ImportDeclarationSpecifier,
    module_name: &str,
) -> Option<ImportBinding> {
    match specifier {
        ImportDeclarationSpecifier::ImportSpecifier(specifier) => {
            let local_name = specifier.local.name.to_string();
            let live_expression = format!(
                "(0, {module_name}{})",
                property_access(&module_export_name(&specifier.imported)),
            );
            Some(ImportBinding {
                declaration_code: format!("const {local_name} = {live_expression};"),
                local_name,
                live_expression,
                symbol_id: specifier.local.symbol_id.get(),
            })
        }
        ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => {
            let local_name = specifier.local.name.to_string();
            let live_expression = format!("(0, {GARFISH_DEFAULT_IMPORT}({module_name}))");
            Some(ImportBinding {
                declaration_code: format!("const {local_name} = {live_expression};"),
                local_name,
                live_expression,
                symbol_id: specifier.local.symbol_id.get(),
            })
        }
        ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => None,
    }
}

fn import_namespace_binding_code(
    specifier: &ImportDeclarationSpecifier,
    module_name: &str,
) -> String {
    match specifier {
        ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => {
            format!(
                "const {} = {GARFISH_NAMESPACE}({module_name});",
                specifier.local.name
            )
        }
        _ => unreachable!("non-namespace import bindings are handled by import_binding"),
    }
}

fn declaration_binding_names(declaration: &Declaration) -> Vec<String> {
    match declaration {
        Declaration::VariableDeclaration(declaration) => {
            variable_declaration_binding_names(declaration)
        }
        Declaration::FunctionDeclaration(function) => function_binding_name(function),
        Declaration::ClassDeclaration(class) => class_binding_name(class),
        _ => Vec::new(),
    }
}

fn variable_declaration_binding_names(declaration: &VariableDeclaration) -> Vec<String> {
    let mut names = Vec::new();
    for declarator in &declaration.declarations {
        collect_binding_names(&declarator.id, &mut names);
    }
    names
}

fn function_binding_name(function: &Function) -> Vec<String> {
    function
        .id
        .as_ref()
        .map(|id| vec![id.name.to_string()])
        .unwrap_or_default()
}

fn class_binding_name(class: &Class) -> Vec<String> {
    class
        .id
        .as_ref()
        .map(|id| vec![id.name.to_string()])
        .unwrap_or_default()
}

fn collect_binding_names(pattern: &BindingPattern, names: &mut Vec<String>) {
    match pattern {
        BindingPattern::BindingIdentifier(identifier) => names.push(identifier.name.to_string()),
        BindingPattern::ObjectPattern(pattern) => {
            for property in &pattern.properties {
                collect_binding_names(&property.value, names);
            }
            if let Some(rest) = &pattern.rest {
                collect_binding_names(&rest.argument, names);
            }
        }
        BindingPattern::ArrayPattern(pattern) => {
            for element in pattern.elements.iter().flatten() {
                collect_binding_names(element, names);
            }
            if let Some(rest) = &pattern.rest {
                collect_binding_names(&rest.argument, names);
            }
        }
        BindingPattern::AssignmentPattern(pattern) => {
            collect_binding_names(&pattern.left, names);
        }
    }
}

fn apply_replacements(source: &str, replacements: &[Replacement]) -> Result<String, String> {
    let mut ordered = replacements.iter().collect::<Vec<_>>();
    ordered.sort_by(|a, b| b.start.cmp(&a.start));

    let mut output = source.to_string();
    let mut last_start = source.len() + 1;
    for replacement in ordered {
        if replacement.end > last_start {
            return Err("Overlapping ESM transformer replacements".to_string());
        }
        if !source.is_char_boundary(replacement.start) || !source.is_char_boundary(replacement.end)
        {
            return Err("ESM transformer replacement is not on a UTF-8 boundary".to_string());
        }
        output.replace_range(replacement.start..replacement.end, &replacement.text);
        last_start = replacement.start;
    }

    Ok(output)
}

fn span_is_inside_ranges(span: Span, ranges: &[(usize, usize)]) -> bool {
    let start = span.start as usize;
    let end = span.end as usize;
    ranges
        .iter()
        .any(|(range_start, range_end)| start >= *range_start && end <= *range_end)
}

fn dedupe_imports(imports: Vec<ImportInfo>) -> Vec<ImportInfo> {
    let mut seen = BTreeSet::new();
    imports
        .into_iter()
        .filter(|import| seen.insert(import.module_id.clone()))
        .collect()
}

fn property_access(name: &str) -> String {
    if is_identifier_name(name) {
        format!(".{name}")
    } else {
        format!("[{}]", string_literal(name))
    }
}

fn is_identifier_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first == '$' || unicode_ident::is_xid_start(first)) {
        return false;
    }
    chars.all(|char| {
        char == '_'
            || char == '$'
            || char == '\u{200c}'
            || char == '\u{200d}'
            || unicode_ident::is_xid_continue(char)
    })
}

fn string_literal(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for char in value.chars() {
        match char {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            '\u{08}' => output.push_str("\\b"),
            '\u{0c}' => output.push_str("\\f"),
            char if char < '\u{20}' => output.push_str(&format!("\\u{:04x}", char as u32)),
            char => output.push(char),
        }
    }
    output.push('"');
    output
}

fn json_string_array(values: &[String]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .map(|value| string_literal(value))
            .collect::<Vec<_>>()
            .join(","),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transform_fixture(source: &str) -> TransformResult {
        transform_to_result(source, "/fixture.js").expect("transform should succeed")
    }

    #[test]
    fn keeps_code_after_no_semicolon_named_export() {
        let result = transform_fixture("const a = 1;\nexport { a }\nfoo();");

        assert!(result.code.contains("foo();"));
        assert!(!result.code.contains("export { a }"));
        assert!(result.code.contains("\"a\": () => a"));
        assert_eq!(result.exports, vec!["a"]);
    }

    #[test]
    fn rewrites_export_declaration_from_ast_spans() {
        let result = transform_fixture("export /* comment */ const value = 1;\nvalue;");

        assert!(result.code.contains("const value = 1"));
        assert!(!result.code.contains("export /* comment */"));
        assert!(result.code.contains("\"value\": () => value"));
        assert_eq!(result.exports, vec!["value"]);
    }

    #[test]
    fn rewrites_default_function_from_ast_spans() {
        let result =
            transform_fixture("export /* comment */ default function read() { return 1; }");

        assert!(result.code.contains("function read() { return 1; }"));
        assert!(!result.code.contains("export /* comment */"));
        assert!(result.code.contains("\"default\": () => read"));
        assert_eq!(result.exports, vec!["default"]);
    }

    #[test]
    fn rewrites_default_expression_from_ast_spans() {
        let result = transform_fixture("export /* comment */ default /* value */ 1 + 2;");

        assert!(result.code.contains("const __GARFISH_DEFAULT__ = 1 + 2"));
        assert!(!result.code.contains("export /* comment */"));
        assert!(
            result
                .code
                .contains("\"default\": () => __GARFISH_DEFAULT__")
        );
        assert_eq!(result.exports, vec!["default"]);
    }

    #[test]
    fn rewrites_import_shorthand_from_identifier_ast() {
        let result = transform_fixture(
            "import { count } from './dep.js';\nconst obj = { count };\nexport { obj };",
        );

        assert!(
            result
                .code
                .contains("const obj = { count: (0, __m0__.count) };")
        );
        assert!(result.code.contains("\"obj\": () => obj"));
    }

    #[test]
    fn reports_parser_errors_with_filename() {
        let error = transform_to_result("export const broken = }", "/broken.js")
            .expect_err("parse should fail");

        assert!(error.contains("/broken.js"));
    }
}
