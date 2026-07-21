const std = @import("std");
const parser = @import("parser");

const gpa = std.heap.wasm_allocator;

export fn alloc(length: usize) [*]u8 {
    return (gpa.alloc(u8, @max(length, 1)) catch @trap()).ptr;
}

export fn free(pointer: [*]u8, length: usize) void {
    gpa.free(pointer[0..@max(length, 1)]);
}

export fn parse(
    source_pointer: [*]const u8,
    source_length: usize,
    filename_pointer: [*]const u8,
    filename_length: usize,
) u32 {
    const source = source_pointer[0..source_length];
    const filename = filename_pointer[0..filename_length];
    var tree = parser.parse(gpa, source, .{
        .source_type = parser.ast.SourceType.fromPath(filename),
        .lang = parser.ast.Lang.fromPath(filename),
        .preserve_parens = true,
        .allow_return_outside_function = false,
        .comments = .none,
    }) catch return std.math.maxInt(u32);
    defer tree.deinit();

    if (tree.hasErrors()) return std.math.maxInt(u32);
    return @intCast(tree.nodes.len);
}
