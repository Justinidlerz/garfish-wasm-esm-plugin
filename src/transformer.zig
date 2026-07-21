const std = @import("std");
const parser = @import("parser");

const GARFISH_DEFAULT = "__GARFISH_DEFAULT__";
const GARFISH_DEFAULT_IMPORT = "__GARFISH_DEFAULT_IMPORT__";
const GARFISH_DYNAMIC_IMPORT = "__GARFISH_DYNAMIC_IMPORT__";
const GARFISH_EXPORT = "__GARFISH_EXPORT__";
const GARFISH_EXPORT_STAR = "__GARFISH_EXPORT_STAR__";
const GARFISH_IMPORT = "__GARFISH_IMPORT__";
const GARFISH_IMPORT_META = "__GARFISH_IMPORT_META__";
const GARFISH_NAMESPACE = "__GARFISH_NAMESPACE__";

const gpa = std.heap.wasm_allocator;

const Replacement = struct {
    start: u32,
    end: u32,
    text: []const u8,
};

const Range = struct {
    start: u32,
    end: u32,
};

const ExportGetter = struct {
    name: []const u8,
    expression: []const u8,
};

const TransformResult = struct {
    source: []const u8,
    replacements: []const Replacement,
    epilogue: []const u8,
    imports: []const []const u8,
    exports: []const []const u8,
};

const ExpressionNodes = struct {
    meta_properties: std.ArrayList(parser.ast.NodeIndex) = .empty,
    import_expressions: std.ArrayList(parser.ast.NodeIndex) = .empty,
    shorthand_properties: std.ArrayList(parser.ast.NodeIndex) = .empty,
};

export fn alloc(length: usize) [*]u8 {
    const allocation_length = @max(length, 1);
    return (gpa.alloc(u8, allocation_length) catch @trap()).ptr;
}

export fn free(pointer: [*]u8, length: usize) void {
    const allocation_length = @max(length, 1);
    gpa.free(pointer[0..allocation_length]);
}

export fn transform(
    source_pointer: [*]const u8,
    source_length: usize,
    filename_pointer: [*]const u8,
    filename_length: usize,
) usize {
    const source = source_pointer[0..source_length];
    const filename = filename_pointer[0..filename_length];
    const output = transformAndSerialize(source, filename) catch |transform_error| {
        const message = std.fmt.allocPrint(
            gpa,
            "Failed to transform {s}: {s}",
            .{ filename, @errorName(transform_error) },
        ) catch @trap();
        defer gpa.free(message);
        return @intFromPtr((serializeFailure(message) catch @trap()).ptr);
    };
    return @intFromPtr(output.ptr);
}

fn transformAndSerialize(source: []const u8, filename: []const u8) ![]u8 {
    var tree = try parser.parse(gpa, source, .{
        .source_type = parser.ast.SourceType.fromPath(filename),
        .lang = parser.ast.Lang.fromPath(filename),
        .preserve_parens = true,
        .allow_return_outside_function = false,
        .comments = .none,
    });
    defer tree.deinit();

    if (firstError(&tree)) |diagnostic| {
        const message = try std.fmt.allocPrint(
            gpa,
            "Failed to parse {s}: {s}",
            .{ filename, diagnostic.message },
        );
        defer gpa.free(message);
        return serializeFailure(message);
    }

    var semantic_visitor = SemanticVisitor{ .arena = tree.allocator() };
    const semantic = try parser.traverser.semantic.traverse(
        SemanticVisitor,
        &tree,
        &semantic_visitor,
    );
    const arena = tree.allocator();
    var transformer = try Transformer.init(
        arena,
        source,
        filename,
        &tree,
        &semantic,
        semantic_visitor.expression_nodes,
    );
    const result = try transformer.run();
    return serializeSuccess(&result);
}

const SemanticVisitor = struct {
    arena: std.mem.Allocator,
    expression_nodes: ExpressionNodes = .{},

    pub fn enter_meta_property(
        self: *SemanticVisitor,
        _: parser.ast.MetaProperty,
        node: parser.ast.NodeIndex,
        _: *parser.traverser.semantic.Ctx,
    ) std.mem.Allocator.Error!parser.traverser.Action {
        try self.expression_nodes.meta_properties.append(self.arena, node);
        return .proceed;
    }

    pub fn enter_import_expression(
        self: *SemanticVisitor,
        _: parser.ast.ImportExpression,
        node: parser.ast.NodeIndex,
        _: *parser.traverser.semantic.Ctx,
    ) std.mem.Allocator.Error!parser.traverser.Action {
        try self.expression_nodes.import_expressions.append(self.arena, node);
        return .proceed;
    }

    pub fn enter_object_property(
        self: *SemanticVisitor,
        property: parser.ast.ObjectProperty,
        node: parser.ast.NodeIndex,
        ctx: *parser.traverser.semantic.Ctx,
    ) std.mem.Allocator.Error!parser.traverser.Action {
        if (property.shorthand and
            ctx.tree.data(property.value) == .identifier_reference)
        {
            try self.expression_nodes.shorthand_properties.append(self.arena, node);
        }
        return .proceed;
    }
};

fn firstError(tree: *const parser.ast.Tree) ?parser.ast.Diagnostic {
    for (tree.diagnostics.items) |diagnostic| {
        if (diagnostic.severity == .@"error") return diagnostic;
    }
    return null;
}

const Transformer = struct {
    arena: std.mem.Allocator,
    source: []const u8,
    filename: []const u8,
    tree: *const parser.ast.Tree,
    semantic: *const parser.semantic.Semantic,
    expression_nodes: ExpressionNodes,
    imports: std.ArrayList([]const u8) = .empty,
    replacements: std.ArrayList(Replacement) = .empty,
    export_getters: std.ArrayList(ExportGetter) = .empty,
    export_names: std.ArrayList([]const u8) = .empty,
    export_star_modules: std.ArrayList([]const u8) = .empty,
    live_bindings: []?[]const u8,
    module_count: u32 = 0,

    fn init(
        arena: std.mem.Allocator,
        source: []const u8,
        filename: []const u8,
        tree: *const parser.ast.Tree,
        semantic: *const parser.semantic.Semantic,
        expression_nodes: ExpressionNodes,
    ) !Transformer {
        const live_bindings = try arena.alloc(?[]const u8, semantic.symbols.len);
        @memset(live_bindings, null);
        var transformer: Transformer = .{
            .arena = arena,
            .source = source,
            .filename = filename,
            .tree = tree,
            .semantic = semantic,
            .expression_nodes = expression_nodes,
            .live_bindings = live_bindings,
        };
        const program = tree.data(tree.root).program;
        const statement_count = tree.extra(program.body).len;
        try transformer.imports.ensureTotalCapacity(arena, statement_count);
        try transformer.export_getters.ensureTotalCapacity(arena, statement_count);
        try transformer.export_names.ensureTotalCapacity(arena, statement_count);
        const expression_count = expression_nodes.meta_properties.items.len +
            expression_nodes.import_expressions.items.len +
            expression_nodes.shorthand_properties.items.len;
        try transformer.replacements.ensureTotalCapacity(
            arena,
            statement_count + expression_count,
        );
        return transformer;
    }

    fn run(self: *Transformer) !TransformResult {
        const program = self.tree.data(self.tree.root).program;
        for (self.tree.extra(program.body)) |statement| {
            try self.transformStatement(statement);
        }

        var statement_ranges: std.ArrayList(Range) = .empty;
        try statement_ranges.ensureTotalCapacity(self.arena, self.replacements.items.len);
        for (self.replacements.items) |replacement| {
            if (replacement.start < replacement.end) {
                try statement_ranges.append(self.arena, .{
                    .start = replacement.start,
                    .end = replacement.end,
                });
            }
        }
        std.mem.sort(Range, statement_ranges.items, {}, rangeLessThan);

        var covered_nodes: std.ArrayList(parser.ast.NodeIndex) = .empty;
        try covered_nodes.ensureTotalCapacity(
            self.arena,
            self.expression_nodes.shorthand_properties.items.len,
        );
        try self.transformCollectedExpressions(&covered_nodes);
        std.mem.sort(
            parser.ast.NodeIndex,
            covered_nodes.items,
            {},
            nodeIndexLessThan,
        );
        try self.transformLiveBindingReferences(statement_ranges.items, covered_nodes.items);

        const exports = try self.sortedExportNames();
        const generated = try self.generateExportCode(exports);
        if (generated.prelude.len > 0) {
            const insertion_offset = self.exportInsertionOffset(program);
            const insertion = try std.fmt.allocPrint(
                self.arena,
                "\n{s}\n",
                .{generated.prelude},
            );
            try self.addReplacement(insertion_offset, insertion_offset, insertion);
        }

        std.mem.sort(Replacement, self.replacements.items, {}, replacementLessThan);
        return .{
            .source = self.source,
            .replacements = self.replacements.items,
            .epilogue = generated.epilogue,
            .imports = self.imports.items,
            .exports = exports,
        };
    }

    fn transformStatement(self: *Transformer, statement: parser.ast.NodeIndex) !void {
        switch (self.tree.data(statement)) {
            .import_declaration => |declaration| {
                try self.transformImportDeclaration(statement, declaration);
            },
            .export_named_declaration => |declaration| {
                try self.transformExportNamedDeclaration(statement, declaration);
            },
            .export_all_declaration => |declaration| {
                try self.transformExportAllDeclaration(statement, declaration);
            },
            .export_default_declaration => |declaration| {
                try self.transformExportDefaultDeclaration(statement, declaration);
            },
            else => {},
        }
    }

    fn transformImportDeclaration(
        self: *Transformer,
        statement: parser.ast.NodeIndex,
        declaration: parser.ast.ImportDeclaration,
    ) !void {
        const module_id = self.nodeName(declaration.source);
        try self.addImport(module_id);
        const module_name = try self.nextModuleName();
        const specifiers = self.tree.extra(declaration.specifiers);

        var output: std.ArrayList(u8) = .empty;
        if (specifiers.len == 0) {
            try output.appendSlice(self.arena, GARFISH_IMPORT ++ "(");
            try appendStringLiteral(&output, self.arena, module_id);
            try output.appendSlice(self.arena, ");");
        } else {
            try output.appendSlice(self.arena, "const ");
            try output.appendSlice(self.arena, module_name);
            try output.appendSlice(self.arena, " = " ++ GARFISH_IMPORT ++ "(");
            try appendStringLiteral(&output, self.arena, module_id);
            try output.appendSlice(self.arena, ");");

            for (specifiers) |specifier| {
                switch (self.tree.data(specifier)) {
                    .import_specifier => |named| {
                        const imported_name = self.nodeName(named.imported);
                        const expression = try self.namedImportExpression(
                            module_name,
                            imported_name,
                        );
                        self.setLiveBinding(named.local, expression);
                    },
                    .import_default_specifier => |default_specifier| {
                        const expression = try std.fmt.allocPrint(
                            self.arena,
                            "(0, " ++ GARFISH_DEFAULT_IMPORT ++ "({s}))",
                            .{module_name},
                        );
                        self.setLiveBinding(default_specifier.local, expression);
                    },
                    .import_namespace_specifier => |namespace| {
                        try output.appendSlice(self.arena, "\nconst ");
                        try output.appendSlice(self.arena, self.nodeName(namespace.local));
                        try output.appendSlice(self.arena, " = " ++ GARFISH_NAMESPACE ++ "(");
                        try output.appendSlice(self.arena, module_name);
                        try output.appendSlice(self.arena, ");");
                    },
                    else => unreachable,
                }
            }
        }

        try self.replaceNode(statement, try output.toOwnedSlice(self.arena));
    }

    fn transformExportNamedDeclaration(
        self: *Transformer,
        statement: parser.ast.NodeIndex,
        declaration: parser.ast.ExportNamedDeclaration,
    ) !void {
        if (declaration.source != .null) {
            const module_id = self.nodeName(declaration.source);
            try self.addImport(module_id);
            const module_name = try self.nextModuleName();
            try self.replaceNode(
                statement,
                try self.staticImportCode(module_name, module_id),
            );

            for (self.tree.extra(declaration.specifiers)) |specifier_node| {
                const specifier = self.tree.data(specifier_node).export_specifier;
                const expression = try self.namedModuleExpression(
                    module_name,
                    self.nodeName(specifier.local),
                );
                try self.addExport(self.nodeName(specifier.exported), expression);
            }
            return;
        }

        if (declaration.declaration != .null) {
            var names: std.ArrayList([]const u8) = .empty;
            try self.collectDeclarationNames(declaration.declaration, &names);
            for (names.items) |name| try self.addExport(name, name);

            const outer_span = self.tree.span(statement);
            const inner_span = self.tree.span(declaration.declaration);
            try self.addReplacement(outer_span.start, inner_span.start, "");
            return;
        }

        for (self.tree.extra(declaration.specifiers)) |specifier_node| {
            const specifier = self.tree.data(specifier_node).export_specifier;
            const local_name = self.nodeName(specifier.local);
            const expression = self.liveBindingOf(specifier.local) orelse local_name;
            try self.addExport(self.nodeName(specifier.exported), expression);
        }
        try self.replaceNode(statement, "");
    }

    fn transformExportAllDeclaration(
        self: *Transformer,
        statement: parser.ast.NodeIndex,
        declaration: parser.ast.ExportAllDeclaration,
    ) !void {
        const module_id = self.nodeName(declaration.source);
        try self.addImport(module_id);
        const module_name = try self.nextModuleName();
        try self.replaceNode(statement, try self.staticImportCode(module_name, module_id));

        if (declaration.exported != .null) {
            const expression = try std.fmt.allocPrint(
                self.arena,
                GARFISH_NAMESPACE ++ "({s})",
                .{module_name},
            );
            try self.addExport(self.nodeName(declaration.exported), expression);
        } else {
            try self.export_star_modules.append(self.arena, module_name);
        }
    }

    fn transformExportDefaultDeclaration(
        self: *Transformer,
        statement: parser.ast.NodeIndex,
        declaration: parser.ast.ExportDefaultDeclaration,
    ) !void {
        const declaration_span = self.tree.span(declaration.declaration);
        const statement_span = self.tree.span(statement);
        switch (self.tree.data(declaration.declaration)) {
            .function => |function| {
                if (function.id != .null) {
                    const name = self.nodeName(function.id);
                    try self.addReplacement(statement_span.start, declaration_span.start, "");
                    try self.addExport("default", name);
                } else {
                    try self.addReplacement(
                        statement_span.start,
                        declaration_span.start,
                        "const " ++ GARFISH_DEFAULT ++ " = ",
                    );
                    try self.addExport("default", GARFISH_DEFAULT);
                }
            },
            .class => |class| {
                if (class.id != .null) {
                    const name = self.nodeName(class.id);
                    try self.addReplacement(statement_span.start, declaration_span.start, "");
                    try self.addExport("default", name);
                } else {
                    try self.addReplacement(
                        statement_span.start,
                        declaration_span.start,
                        "const " ++ GARFISH_DEFAULT ++ " = ",
                    );
                    try self.addExport("default", GARFISH_DEFAULT);
                }
            },
            else => {
                try self.addReplacement(
                    statement_span.start,
                    declaration_span.start,
                    "const " ++ GARFISH_DEFAULT ++ " = ",
                );
                try self.addExport("default", GARFISH_DEFAULT);
            },
        }
    }

    fn transformLiveBindingReferences(
        self: *Transformer,
        statement_ranges: []const Range,
        covered_nodes: []const parser.ast.NodeIndex,
    ) !void {
        for (self.live_bindings, 0..) |maybe_expression, symbol_index| {
            const expression = maybe_expression orelse continue;
            for (self.semantic.uses(@enumFromInt(symbol_index))) |reference_id| {
                const reference = self.semantic.reference(reference_id);
                if (reference.flags.write) continue;
                if (containsNodeIndex(covered_nodes, reference.node)) continue;

                const span = self.tree.span(reference.node);
                if (spanInsideRanges(span, statement_ranges)) continue;
                try self.addReplacement(span.start, span.end, expression);
            }
        }
    }

    fn transformCollectedExpressions(
        self: *Transformer,
        covered_nodes: *std.ArrayList(parser.ast.NodeIndex),
    ) !void {
        for (self.expression_nodes.meta_properties.items) |node| {
            const meta_property = self.tree.data(node).meta_property;
            const meta = self.nodeName(meta_property.meta);
            const property = self.nodeName(meta_property.property);
            if (std.mem.eql(u8, meta, "import") and
                std.mem.eql(u8, property, "meta"))
            {
                const span = self.tree.span(node);
                try self.addReplacement(
                    span.start,
                    span.end,
                    GARFISH_IMPORT_META ++ ".meta",
                );
            }
        }

        for (self.expression_nodes.import_expressions.items) |node| {
            const span = self.tree.span(node);
            try self.addReplacement(
                span.start,
                span.start + "import".len,
                GARFISH_DYNAMIC_IMPORT,
            );
        }

        for (self.expression_nodes.shorthand_properties.items) |node| {
            const property = self.tree.data(node).object_property;
            const expression = self.liveBindingOf(property.value) orelse continue;
            const key = self.nodeName(property.value);
            const replacement = try std.fmt.allocPrint(
                self.arena,
                "{s}: {s}",
                .{ key, expression },
            );
            const span = self.tree.span(node);
            try self.addReplacement(span.start, span.end, replacement);
            try covered_nodes.append(self.arena, property.value);
        }
    }

    fn generateExportCode(
        self: *Transformer,
        exports: []const []const u8,
    ) !struct { prelude: []const u8, epilogue: []const u8 } {
        var prelude: std.ArrayList(u8) = .empty;
        if (self.export_getters.items.len > 0) {
            try prelude.appendSlice(self.arena, GARFISH_EXPORT ++ "({\n");
            for (self.export_getters.items, 0..) |getter, index| {
                if (index > 0) try prelude.appendSlice(self.arena, ",\n");
                try appendStringLiteral(&prelude, self.arena, getter.name);
                try prelude.appendSlice(self.arena, ": () => ");
                try prelude.appendSlice(self.arena, getter.expression);
            }
            try prelude.appendSlice(self.arena, "\n});");
        }

        var excludes: std.ArrayList([]const u8) = .empty;
        try excludes.append(self.arena, "default");
        for (exports) |name| {
            if (!std.mem.eql(u8, name, "default")) try excludes.append(self.arena, name);
        }
        std.mem.sort([]const u8, excludes.items, {}, lessThanString);

        var epilogue: std.ArrayList(u8) = .empty;
        for (self.export_star_modules.items) |module_name| {
            try epilogue.appendSlice(self.arena, "\n" ++ GARFISH_EXPORT_STAR ++ "(");
            try epilogue.appendSlice(self.arena, module_name);
            try epilogue.appendSlice(self.arena, ", ");
            try appendStringArray(&epilogue, self.arena, excludes.items);
            try epilogue.appendSlice(self.arena, ");");
        }

        return .{
            .prelude = try prelude.toOwnedSlice(self.arena),
            .epilogue = try epilogue.toOwnedSlice(self.arena),
        };
    }

    fn exportInsertionOffset(
        self: *const Transformer,
        program: parser.ast.Program,
    ) u32 {
        var offset: u32 = 0;
        for (self.tree.extra(program.body)) |statement| {
            if (self.tree.data(statement) != .directive) break;
            offset = self.tree.span(statement).end;
        }
        if (offset > 0) return offset;
        if (program.hashbang != null) {
            if (std.mem.findScalar(u8, self.source, '\n')) |newline| {
                return @intCast(newline);
            }
            return @intCast(self.source.len);
        }
        return 0;
    }

    fn sortedExportNames(self: *Transformer) ![]const []const u8 {
        std.mem.sort([]const u8, self.export_names.items, {}, lessThanString);
        return self.export_names.items;
    }

    fn collectDeclarationNames(
        self: *Transformer,
        declaration: parser.ast.NodeIndex,
        names: *std.ArrayList([]const u8),
    ) !void {
        switch (self.tree.data(declaration)) {
            .variable_declaration => |variable| {
                for (self.tree.extra(variable.declarators)) |declarator_node| {
                    const declarator = self.tree.data(declarator_node).variable_declarator;
                    try self.collectBindingNames(declarator.id, names);
                }
            },
            .function => |function| {
                if (function.id != .null) try names.append(self.arena, self.nodeName(function.id));
            },
            .class => |class| {
                if (class.id != .null) try names.append(self.arena, self.nodeName(class.id));
            },
            else => {},
        }
    }

    fn collectBindingNames(
        self: *Transformer,
        binding: parser.ast.NodeIndex,
        names: *std.ArrayList([]const u8),
    ) !void {
        if (binding == .null) return;
        switch (self.tree.data(binding)) {
            .binding_identifier => try names.append(self.arena, self.nodeName(binding)),
            .object_pattern => |pattern| {
                for (self.tree.extra(pattern.properties)) |property_node| {
                    const property = self.tree.data(property_node).binding_property;
                    try self.collectBindingNames(property.value, names);
                }
                try self.collectBindingNames(pattern.rest, names);
            },
            .array_pattern => |pattern| {
                for (self.tree.extra(pattern.elements)) |element| {
                    try self.collectBindingNames(element, names);
                }
                try self.collectBindingNames(pattern.rest, names);
            },
            .assignment_pattern => |pattern| try self.collectBindingNames(pattern.left, names),
            .binding_rest_element => |rest| try self.collectBindingNames(rest.argument, names),
            else => {},
        }
    }

    fn setLiveBinding(
        self: *Transformer,
        local: parser.ast.NodeIndex,
        expression: []const u8,
    ) void {
        const symbol = self.semantic.symbolOf(local) orelse return;
        self.live_bindings[@intFromEnum(symbol)] = expression;
    }

    fn liveBindingOf(
        self: *const Transformer,
        node: parser.ast.NodeIndex,
    ) ?[]const u8 {
        const symbol = self.semantic.symbolOf(node) orelse return null;
        return self.live_bindings[@intFromEnum(symbol)];
    }

    fn namedImportExpression(
        self: *Transformer,
        module_name: []const u8,
        imported_name: []const u8,
    ) ![]const u8 {
        const module_expression = try self.namedModuleExpression(module_name, imported_name);
        return std.fmt.allocPrint(self.arena, "(0, {s})", .{module_expression});
    }

    fn namedModuleExpression(
        self: *Transformer,
        module_name: []const u8,
        imported_name: []const u8,
    ) ![]const u8 {
        var output: std.ArrayList(u8) = .empty;
        try output.appendSlice(self.arena, module_name);
        if (isAsciiIdentifierName(imported_name)) {
            try output.append(self.arena, '.');
            try output.appendSlice(self.arena, imported_name);
        } else {
            try output.append(self.arena, '[');
            try appendStringLiteral(&output, self.arena, imported_name);
            try output.append(self.arena, ']');
        }
        return output.toOwnedSlice(self.arena);
    }

    fn staticImportCode(
        self: *Transformer,
        module_name: []const u8,
        module_id: []const u8,
    ) ![]const u8 {
        var output: std.ArrayList(u8) = .empty;
        try output.appendSlice(self.arena, "const ");
        try output.appendSlice(self.arena, module_name);
        try output.appendSlice(self.arena, " = " ++ GARFISH_IMPORT ++ "(");
        try appendStringLiteral(&output, self.arena, module_id);
        try output.appendSlice(self.arena, ");");
        return output.toOwnedSlice(self.arena);
    }

    fn nextModuleName(self: *Transformer) ![]const u8 {
        const name = try std.fmt.allocPrint(self.arena, "__m{d}__", .{self.module_count});
        self.module_count += 1;
        return name;
    }

    fn nodeName(self: *const Transformer, node: parser.ast.NodeIndex) []const u8 {
        return switch (self.tree.data(node)) {
            .binding_identifier => |identifier| self.tree.string(identifier.name),
            .identifier_reference => |identifier| self.tree.string(identifier.name),
            .identifier_name => |identifier| self.tree.string(identifier.name),
            .string_literal => |literal| self.tree.string(literal.value),
            else => unreachable,
        };
    }

    fn addImport(self: *Transformer, module_id: []const u8) !void {
        if (!containsString(self.imports.items, module_id)) {
            try self.imports.append(self.arena, module_id);
        }
    }

    fn addExport(
        self: *Transformer,
        name: []const u8,
        expression: []const u8,
    ) !void {
        try self.export_getters.append(self.arena, .{
            .name = name,
            .expression = expression,
        });
        if (!containsString(self.export_names.items, name)) {
            try self.export_names.append(self.arena, name);
        }
    }

    fn replaceNode(
        self: *Transformer,
        node: parser.ast.NodeIndex,
        text: []const u8,
    ) !void {
        const span = self.tree.span(node);
        try self.addReplacement(span.start, span.end, text);
    }

    fn addReplacement(
        self: *Transformer,
        start: u32,
        end: u32,
        text: []const u8,
    ) std.mem.Allocator.Error!void {
        std.debug.assert(start <= end);
        try self.replacements.append(self.arena, .{
            .start = start,
            .end = end,
            .text = text,
        });
    }
};

fn serializeSuccess(result: *const TransformResult) ![]u8 {
    const code_length = try transformedCodeLength(result);
    var payload_length: usize = 4;
    payload_length = try addByteSliceSize(payload_length, code_length);
    payload_length = try std.math.add(usize, payload_length, 4);
    for (result.imports) |module_id| {
        payload_length = try addStringSize(payload_length, module_id);
    }
    payload_length = try std.math.add(usize, payload_length, 4);
    for (result.exports) |export_name| {
        payload_length = try addStringSize(payload_length, export_name);
    }

    const output = try gpa.alloc(u8, try std.math.add(usize, payload_length, 4));
    var offset: usize = 0;
    writeU32(output, &offset, payload_length);
    writeU32(output, &offset, 0);
    writeU32(output, &offset, code_length);
    writeTransformedCode(output, &offset, result);
    writeU32(output, &offset, result.imports.len);
    for (result.imports) |module_id| writeString(output, &offset, module_id);
    writeU32(output, &offset, result.exports.len);
    for (result.exports) |export_name| writeString(output, &offset, export_name);
    std.debug.assert(offset == output.len);
    return output;
}

fn transformedCodeLength(result: *const TransformResult) !usize {
    var length = try std.math.add(usize, result.source.len, result.epilogue.len);
    var cursor: u32 = 0;
    for (result.replacements) |replacement| {
        if (replacement.end > result.source.len) return error.InvalidReplacementSpan;
        if (replacement.start < cursor) return error.OverlappingReplacements;
        length = try std.math.sub(usize, length, replacement.end - replacement.start);
        length = try std.math.add(usize, length, replacement.text.len);
        cursor = replacement.end;
    }
    return length;
}

fn writeTransformedCode(
    output: []u8,
    offset: *usize,
    result: *const TransformResult,
) void {
    var cursor: u32 = 0;
    for (result.replacements) |replacement| {
        writeBytes(output, offset, result.source[cursor..replacement.start]);
        writeBytes(output, offset, replacement.text);
        cursor = replacement.end;
    }
    writeBytes(output, offset, result.source[cursor..]);
    writeBytes(output, offset, result.epilogue);
}

fn serializeFailure(message: []const u8) ![]u8 {
    const payload_length = try addStringSize(4, message);
    const output = try gpa.alloc(u8, try std.math.add(usize, payload_length, 4));
    var offset: usize = 0;
    writeU32(output, &offset, payload_length);
    writeU32(output, &offset, 1);
    writeString(output, &offset, message);
    std.debug.assert(offset == output.len);
    return output;
}

fn addStringSize(total: usize, value: []const u8) !usize {
    return addByteSliceSize(total, value.len);
}

fn addByteSliceSize(total: usize, length: usize) !usize {
    return std.math.add(usize, try std.math.add(usize, total, 4), length);
}

fn writeU32(output: []u8, offset: *usize, value: usize) void {
    const end = offset.* + 4;
    std.mem.writeInt(u32, output[offset.*..][0..4], @intCast(value), .little);
    offset.* = end;
}

fn writeString(output: []u8, offset: *usize, value: []const u8) void {
    writeU32(output, offset, value.len);
    writeBytes(output, offset, value);
}

fn writeBytes(output: []u8, offset: *usize, value: []const u8) void {
    const end = offset.* + value.len;
    @memcpy(output[offset.*..end], value);
    offset.* = end;
}

fn appendStringLiteral(
    output: *std.ArrayList(u8),
    arena: std.mem.Allocator,
    value: []const u8,
) !void {
    const hex = "0123456789abcdef";
    try output.append(arena, '"');
    for (value) |byte| {
        switch (byte) {
            '"' => try output.appendSlice(arena, "\\\""),
            '\\' => try output.appendSlice(arena, "\\\\"),
            '\n' => try output.appendSlice(arena, "\\n"),
            '\r' => try output.appendSlice(arena, "\\r"),
            '\t' => try output.appendSlice(arena, "\\t"),
            0x08 => try output.appendSlice(arena, "\\b"),
            0x0c => try output.appendSlice(arena, "\\f"),
            0x00...0x07, 0x0b, 0x0e...0x1f => {
                try output.appendSlice(arena, "\\u00");
                try output.append(arena, hex[byte >> 4]);
                try output.append(arena, hex[byte & 0x0f]);
            },
            else => try output.append(arena, byte),
        }
    }
    try output.append(arena, '"');
}

fn appendStringArray(
    output: *std.ArrayList(u8),
    arena: std.mem.Allocator,
    values: []const []const u8,
) !void {
    try output.append(arena, '[');
    for (values, 0..) |value, index| {
        if (index > 0) try output.append(arena, ',');
        try appendStringLiteral(output, arena, value);
    }
    try output.append(arena, ']');
}

fn spanInsideRanges(span: parser.ast.Span, ranges: []const Range) bool {
    var low: usize = 0;
    var high = ranges.len;
    while (low < high) {
        const middle = low + (high - low) / 2;
        if (ranges[middle].start <= span.start) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    if (low == 0) return false;
    return span.end <= ranges[low - 1].end;
}

fn containsNodeIndex(
    values: []const parser.ast.NodeIndex,
    target: parser.ast.NodeIndex,
) bool {
    var low: usize = 0;
    var high = values.len;
    const target_index = @intFromEnum(target);
    while (low < high) {
        const middle = low + (high - low) / 2;
        const middle_index = @intFromEnum(values[middle]);
        if (middle_index < target_index) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low < values.len and values[low] == target;
}

fn containsString(values: []const []const u8, target: []const u8) bool {
    for (values) |value| {
        if (std.mem.eql(u8, value, target)) return true;
    }
    return false;
}

fn isAsciiIdentifierName(value: []const u8) bool {
    if (value.len == 0) return false;
    if (!isAsciiIdentifierStart(value[0])) return false;
    for (value[1..]) |byte| {
        if (!isAsciiIdentifierContinue(byte)) return false;
    }
    return true;
}

fn isAsciiIdentifierStart(byte: u8) bool {
    return byte == '_' or byte == '$' or std.ascii.isAlphabetic(byte);
}

fn isAsciiIdentifierContinue(byte: u8) bool {
    return isAsciiIdentifierStart(byte) or std.ascii.isDigit(byte);
}

fn lessThanString(_: void, left: []const u8, right: []const u8) bool {
    return std.mem.order(u8, left, right) == .lt;
}

fn replacementLessThan(_: void, left: Replacement, right: Replacement) bool {
    if (left.start != right.start) return left.start < right.start;
    return left.end < right.end;
}

fn rangeLessThan(_: void, left: Range, right: Range) bool {
    if (left.start != right.start) return left.start < right.start;
    return left.end < right.end;
}

fn nodeIndexLessThan(
    _: void,
    left: parser.ast.NodeIndex,
    right: parser.ast.NodeIndex,
) bool {
    return @intFromEnum(left) < @intFromEnum(right);
}
