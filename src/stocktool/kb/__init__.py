"""StockTool 知识库：格式规范见 docs/kb-format.md。

App 是引擎，知识库是内容。这个包负责二者的边界：
导出、载入、校验。
"""

from .bundle import KBError, read_bundle, write_bundle
from .exporter import export_kb
from .importer import LoadedKB, import_document_texts, import_kb, load_kb
from .validator import format_report, validate_kb

__all__ = [
    "KBError", "read_bundle", "write_bundle",
    "export_kb",
    "LoadedKB", "load_kb", "import_kb", "import_document_texts",
    "validate_kb", "format_report",
]
