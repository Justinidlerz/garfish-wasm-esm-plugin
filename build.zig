const std = @import("std");

pub fn build(builder: *std.Build) void {
    const optimize = builder.standardOptimizeOption(.{});
    const wasm_target = builder.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
        .cpu_features_add = std.Target.wasm.featureSet(&.{
            .bulk_memory,
            .nontrapping_fptoint,
            .sign_ext,
            .simd128,
        }),
    });

    const yuku = builder.dependency("yuku", .{
        .target = wasm_target,
        .optimize = optimize,
        .@"codegen-source-maps" = false,
    });
    const wasm_module = builder.createModule(.{
        .root_source_file = builder.path("src/transformer.zig"),
        .target = wasm_target,
        .optimize = optimize,
        .strip = true,
    });
    wasm_module.addImport("parser", yuku.module("parser"));

    const wasm = builder.addExecutable(.{
        .name = "garfish_wasm_esm_plugin_bg",
        .root_module = wasm_module,
    });
    wasm.entry = .disabled;
    wasm.rdynamic = true;

    const wasm_step = builder.step("wasm", "Build the Zig WebAssembly transformer");
    wasm_step.dependOn(&builder.addInstallArtifact(wasm, .{}).step);

    const parse_benchmark_module = builder.createModule(.{
        .root_source_file = builder.path("benchmarks/parse.zig"),
        .target = wasm_target,
        .optimize = optimize,
        .strip = true,
    });
    parse_benchmark_module.addImport("parser", yuku.module("parser"));
    const parse_benchmark = builder.addExecutable(.{
        .name = "garfish_parse_benchmark",
        .root_module = parse_benchmark_module,
    });
    parse_benchmark.entry = .disabled;
    parse_benchmark.rdynamic = true;

    const parse_benchmark_step = builder.step(
        "parse-benchmark",
        "Build the Yuku parse benchmark WebAssembly module",
    );
    parse_benchmark_step.dependOn(
        &builder.addInstallArtifact(parse_benchmark, .{}).step,
    );
}
