<?php
// api.php

// Keep errors out of the HTTP response (a stray warning would corrupt the JSON
// body and can leak file paths), but DO report and log them so real bugs are
// discoverable in the server log during development instead of silently vanishing.
error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');
ini_set('memory_limit', '512M');
set_time_limit(120);

// Mark the session cookie Secure when the request arrived over HTTPS so it is
// never sent back over plaintext. HttpOnly keeps it away from JS (XSS), and
// SameSite=Lax blocks it from being sent on cross-site POSTs (CSRF).
$cookieSecure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || (($_SERVER['SERVER_PORT'] ?? '') == 443)
    || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');

session_set_cookie_params([
    'lifetime' => 0,
    'path' => '/',
    'secure' => $cookieSecure,
    'httponly' => true,
    'samesite' => 'Lax'
]);
session_start();

header('Content-Type: application/json; charset=utf-8');
// Defense-in-depth headers for the API responses.
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');

// Per-session CSRF token. Issued on first contact and handed to the frontend via
// check_session / connect; every state-changing request must echo it back in the
// X-CSRF-Token header. SameSite=Lax already blocks most cross-site POSTs, but a
// token closes the gap for same-site and GET-based bypasses.
if (empty($_SESSION['csrf_token'])) {
    $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
}

// Get JSON input for POST requests
$rawInput = file_get_contents('php://input');
$input = json_decode($rawInput, true) ?: [];
$action = $_GET['action'] ?? ($input['action'] ?? ($_POST['action'] ?? ''));

// Helper to get request param from POST, GET or JSON input
function getParam($key, $default = null) {
    global $input;
    if (isset($_POST[$key])) return $_POST[$key];
    if (isset($_GET[$key])) return $_GET[$key];
    if (isset($input[$key])) return $input[$key];
    return $default;
}

// Helper to get PDO connection using stored session credentials
function getDB()
{
    if (empty($_SESSION['db_host'])) {
        throw new Exception('Not connected. Please log in.', 401);
    }

    $host = $_SESSION['db_host'];
    $port = $_SESSION['db_port'] ?? '3306';
    $dsn = "mysql:host={$host};port={$port};charset=utf8mb4";
    if (!empty($_SESSION['db_name'])) {
        $dsn .= ";dbname=" . $_SESSION['db_name'];
    }

    $pdo = new PDO($dsn, $_SESSION['db_user'], $_SESSION['db_pass'] ?? '', [
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::MYSQL_ATTR_INIT_COMMAND => "SET NAMES utf8mb4"
    ]);

    return $pdo;
}

// Helper to escape backticks in SQL identifiers
function escapeId($name) {
    return str_replace('`', '``', $name);
}

// Helper to parse and split multi-statement SQL strings
function splitSqlStatements($sql) {
    if (substr($sql, 0, 3) === "\xEF\xBB\xBF") {
        $sql = substr($sql, 3);
    }

    $queries = [];
    $len = strlen($sql);
    $query = '';
    $inString = false;
    $stringChar = '';
    $inComment = false;
    $commentType = '';
    $delimiter = ';';
    $delimLen = 1;
    $i = 0;

    while ($i < $len) {
        $char = $sql[$i];
        $next = ($i + 1 < $len) ? $sql[$i + 1] : '';

        // Check comment start outside of strings
        if (!$inString && !$inComment) {
            if ($char === '-' && $next === '-') {
                $third = ($i + 2 < $len) ? $sql[$i + 2] : '';
                if ($third === ' ' || $third === "\t" || $third === "\n" || $third === "\r" || $third === '') {
                    $inComment = true;
                    $commentType = '--';
                    $i += 2;
                    continue;
                }
            } elseif ($char === '#') {
                $inComment = true;
                $commentType = '#';
                $i++;
                continue;
            } elseif ($char === '/' && $next === '*') {
                $inComment = true;
                $commentType = '/*';
                $i += 2;
                continue;
            }
        }

        // Inside comment
        if ($inComment) {
            if ($commentType === '--' || $commentType === '#') {
                if ($char === "\n" || $char === "\r") {
                    $inComment = false;
                }
            } elseif ($commentType === '/*') {
                if ($char === '*' && $next === '/') {
                    $inComment = false;
                    $i += 2;
                    continue;
                }
            }
            $i++;
            continue;
        }

        // Inside string or identifier
        if ($char === "'" || $char === '"' || $char === '`') {
            if (!$inString) {
                $inString = true;
                $stringChar = $char;
            } elseif ($stringChar === $char) {
                $escaped = false;
                $backslashCount = 0;
                $k = $i - 1;
                while ($k >= 0 && $sql[$k] === '\\') {
                    $backslashCount++;
                    $k--;
                }
                if ($backslashCount % 2 === 1) {
                    $escaped = true;
                } elseif ($next === $char) {
                    $query .= $char . $next;
                    $i += 2;
                    continue;
                }
                if (!$escaped) {
                    $inString = false;
                }
            }
        }

        // Check custom DELIMITER command
        if (!$inString && preg_match('/^\s*DELIMITER\s+(\S+)/i', substr($sql, $i, 30), $m)) {
            $delimiter = $m[1];
            $delimLen = strlen($delimiter);
            $i += strlen($m[0]);
            continue;
        }

        // Check query delimiter
        if (!$inString && substr($sql, $i, $delimLen) === $delimiter) {
            $trimmed = trim($query);
            if ($trimmed !== '') {
                $queries[] = $trimmed;
            }
            $query = '';
            $i += $delimLen;
            continue;
        }

        $query .= $char;
        $i++;
    }

    $trimmed = trim($query);
    if ($trimmed !== '') {
        $queries[] = $trimmed;
    }

    return $queries;
}

// Map every object in a database to its type ('BASE TABLE' or 'VIEW').
// $safeDb must already be passed through escapeId().
function tableTypes($pdo, $safeDb) {
    $types = [];
    $stmt = $pdo->query("SHOW FULL TABLES FROM `$safeDb`");
    while ($row = $stmt->fetch(PDO::FETCH_NUM)) {
        $types[$row[0]] = $row[1];
    }
    return $types;
}

// Foreign keys of a table, keyed by column: the table and column each one points
// at, and which column of that table reads as a name for it ('label', null if
// there is none). Takes raw (unescaped) names.
function fkMeta($pdo, $rawDb, $rawTable) {
    $stmt = $pdo->prepare("SELECT COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION");
    $stmt->execute([$rawDb, $rawTable]);
    $meta = [];
    $labelCache = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $fk) {
        $col = $fk['COLUMN_NAME'];
        if (isset($meta[$col])) continue; // in two FKs: the first one wins
        $schema = $fk['REFERENCED_TABLE_SCHEMA'] ?: $rawDb;
        $table = $fk['REFERENCED_TABLE_NAME'];
        $refCol = $fk['REFERENCED_COLUMN_NAME'];
        $key = "$schema\0$table\0$refCol";
        if (!array_key_exists($key, $labelCache)) {
            $labelCache[$key] = fkTargetInfo($pdo, $schema, $table, $refCol);
        }
        $meta[$col] = ['schema' => $schema, 'table' => $table, 'column' => $refCol] + $labelCache[$key];
    }
    return $meta;
}

// About the referenced table: 'label' is the column that best names a row (a
// well-known name column, else the first short text column, else null) and
// 'numeric' says whether the referenced key is a number.
function fkTargetInfo($pdo, $schema, $table, $refCol) {
    try {
        $cols = $pdo->query("SHOW COLUMNS FROM `" . escapeId($schema) . "`.`" . escapeId($table) . "`")->fetchAll(PDO::FETCH_ASSOC);
    } catch (Exception $e) {
        return ['label' => null, 'numeric' => false];
    }
    $numeric = false;
    $byLower = [];
    foreach ($cols as $c) {
        $byLower[strtolower($c['Field'])] = $c['Field'];
        if ($c['Field'] === $refCol) $numeric = (bool)preg_match('/int|decimal|numeric|float|double/i', $c['Type']);
    }
    $label = null;
    $preferred = ['name_kh', 'name_en', 'name', 'full_name', 'display_name', 'title', 'label', 'code', 'description', 'email', 'username'];
    foreach ($preferred as $cand) {
        if (isset($byLower[$cand]) && $byLower[$cand] !== $refCol) { $label = $byLower[$cand]; break; }
    }
    if ($label === null) {
        foreach ($cols as $c) {
            if ($c['Field'] !== $refCol && preg_match('/^(var)?char\(/i', $c['Type'])) { $label = $c['Field']; break; }
        }
    }
    return ['label' => $label, 'numeric' => $numeric];
}

// Look up the referenced rows for some values of one FK column. Returns
// [value => label] for every value that exists (label = the value itself when
// the referenced table has no name column), so a missing key means an orphan.
function fkLabels($pdo, array $fk, array $values) {
    $values = array_values(array_unique(array_map('strval', array_filter($values, function ($v) {
        return $v !== null;
    }))));
    if (!$values) return [];
    $ref = '`' . escapeId($fk['column']) . '`';
    $label = $fk['label'] !== null ? '`' . escapeId($fk['label']) . '`' : $ref;
    $src = '`' . escapeId($fk['schema']) . '`.`' . escapeId($fk['table']) . '`';
    $out = [];
    foreach (array_chunk($values, 500) as $chunk) {
        $ph = implode(',', array_fill(0, count($chunk), '?'));
        $stmt = $pdo->prepare("SELECT $ref AS v, $label AS l FROM $src WHERE $ref IN ($ph)");
        $stmt->execute($chunk);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) $out[(string)$r['v']] = $r['l'];
    }
    return $out;
}

// Validate a new table name: MySQL allows almost anything inside backticks, but
// not an empty name, more than 64 characters, or trailing spaces.
function validTableName($name) {
    $name = (string)$name;
    if (trim($name) === '') throw new Exception('Table name is required.');
    if ($name !== rtrim($name)) throw new Exception('Table name cannot end with a space.');
    if (mb_strlen($name) > 64) throw new Exception('Table name cannot be longer than 64 characters.');
    return $name;
}

// The `tables` list sent by the Objects view for bulk operations.
function tableListParam($input) {
    $list = $input['tables'] ?? [];
    if (!is_array($list)) throw new Exception('A list of tables is required.');
    $list = array_values(array_unique(array_filter($list, function ($t) {
        return is_string($t) && $t !== '';
    })));
    if (empty($list)) throw new Exception('Select at least one table.');
    return $list;
}

// Remove `DEFINER=user@host` from a CREATE VIEW/TRIGGER/PROCEDURE/FUNCTION/EVENT
// statement. Without this, importing the dump as a different user or on another
// server fails with error 1227 unless the importer has SUPER / SET_USER_ID.
// "SQL SECURITY DEFINER" has no "=", so it is left alone.
function stripDefiner($sql) {
    $part = '(?:`(?:[^`]|``)*`|\'(?:[^\']|\'\')*\'|[^\s@]+)';
    return preg_replace('/\sDEFINER\s*=\s*' . $part . '@' . $part . '/', '', $sql, 1);
}

// Order views so a view that selects from another view is created after it.
// SHOW CREATE VIEW backtick-quotes every identifier, so a reference to view v
// appears as the literal text `v`. A false match (e.g. a column alias sharing a
// view's name) only costs ordering; a cycle falls back to the original order.
function orderViewsByDependency(array $defs) {
    $ordered = [];
    $pending = $defs;
    while ($pending) {
        $progress = false;
        foreach ($pending as $name => $def) {
            $blocked = false;
            foreach ($pending as $other => $_) {
                if ((string)$other !== (string)$name && strpos($def, '`' . escapeId($other) . '`') !== false) {
                    $blocked = true;
                    break;
                }
            }
            if (!$blocked) {
                $ordered[] = $name;
                unset($pending[$name]);
                $progress = true;
            }
        }
        if (!$progress) {
            foreach ($pending as $name => $_) $ordered[] = $name;
            break;
        }
    }
    return $ordered;
}

// Builds an SQL dump of $selectedTables in database $rawDb ($db is the same name
// passed through escapeId). Used by the export download and by server-side
// backups. Options: export_type (all|structure|data), add_drop_table,
// add_create_db, disable_fk, include_routines, keep_definer, single_table.
// Returns [sql text, number of data rows dumped].
function buildSqlDump($pdo, $db, $rawDb, array $selectedTables, array $o) {
    $exportType = $o['export_type'];
    $addDropTable = $o['add_drop_table'];
    $addCreateDb = $o['add_create_db'];
    $disableFk = $o['disable_fk'];
    $includeRoutines = $o['include_routines'];
    $keepDefiner = $o['keep_definer'];
    $singleTable = $o['single_table'];

    // Large databases don't fit in memory as one string. With an 'emit' callback the
    // dump is handed over in ~1 MB pieces as it is built (streamed to the browser or
    // written to a file); without one it is returned as a string, capped at 'max_bytes'.
    $emit = $o['emit'] ?? null;
    $maxBytes = $o['max_bytes'] ?? 0;
    $output = '';
    $flush = function ($force = false) use (&$output, $emit, $maxBytes) {
        if ($emit) {
            if ($output !== '' && ($force || strlen($output) >= 1048576)) {
                $emit($output);
                $output = '';
            }
        } elseif ($maxBytes && strlen($output) > $maxBytes) {
            throw new Exception('This export is too big to preview (over ' . round($maxBytes / 1048576) . ' MB). Use Download instead.');
        }
    };

    $time = date('Y-m-d H:i:s');
    $host = $_SESSION['db_host'] ?? 'localhost';
    $port = $_SESSION['db_port'] ?? '3306';
    $serverVer = '';
    try { $serverVer = $pdo->getAttribute(PDO::ATTR_SERVER_VERSION); } catch (Exception $e) {}

    $output .= "-- DBManager SQL Dump\n"
            . "-- Version 2.0\n"
            . "-- Host: {$host}:{$port}\n"
            . "-- Generation Time: {$time}\n"
            . "-- Server version: {$serverVer}\n"
            . "-- Database: `{$rawDb}`\n\n";

    if ($disableFk) {
        $output .= "SET FOREIGN_KEY_CHECKS = 0;\n";
        $output .= "SET SQL_MODE = \"NO_AUTO_VALUE_ON_ZERO\";\n";
        $output .= "SET time_zone = \"+00:00\";\n\n";
    }

    if ($addCreateDb && empty($singleTable)) {
        $output .= "CREATE DATABASE IF NOT EXISTS `{$rawDb}` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n";
        $output .= "USE `{$rawDb}`;\n\n";
    }

    $totalRowsDumped = 0;
    $withStructure = ($exportType === 'all' || $exportType === 'structure');

    // Views can't go through SHOW CREATE TABLE / INSERT like base
    // tables, so split the selection by type first.
    $tableTypes = tableTypes($pdo, $db);
    $baseTables = [];
    $views = [];
    foreach ($selectedTables as $t) {
        if (($tableTypes[$t] ?? '') === 'VIEW') {
            $views[] = $t;
        } else {
            $baseTables[] = $t;
        }
    }

    foreach ($baseTables as $t) {
        $safeT = escapeId($t);
        $output .= "-- --------------------------------------------------------\n"
                 . "-- Table structure for table `{$t}`\n"
                 . "-- --------------------------------------------------------\n\n";

        if ($exportType === 'all' || $exportType === 'structure') {
            if ($addDropTable) {
                $output .= "DROP TABLE IF EXISTS `{$safeT}`;\n";
            }
            $createStmt = $pdo->query("SHOW CREATE TABLE `{$safeT}`")->fetch(PDO::FETCH_ASSOC);
            if (!empty($createStmt['Create Table'])) {
                $output .= $createStmt['Create Table'] . ";\n\n";
            }
        }

        if ($exportType === 'all' || $exportType === 'data') {
            // Unbuffered: rows come from the server one by one instead of the whole
            // table being loaded into PHP memory first (a 200 MB table would not fit).
            $pdo->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, false);
            $rowsStmt = $pdo->query("SELECT * FROM `{$safeT}`");
            try {
            $cols = [];
            if ($rowsStmt->columnCount() > 0) {
                for ($i = 0; $i < $rowsStmt->columnCount(); $i++) {
                    $m = $rowsStmt->getColumnMeta($i);
                    $cols[] = $m['name'];
                }
            }

            if (!empty($cols)) {
                $escapedCols = array_map(function($c) { return '`' . escapeId($c) . '`'; }, $cols);
                $colList = implode(', ', $escapedCols);

                $chunk = [];
                $hasData = false;
                while ($row = $rowsStmt->fetch(PDO::FETCH_NUM)) {
                    if (!$hasData) {
                        $output .= "-- Dumping data for table `{$t}`\n\n";
                        $hasData = true;
                    }
                    $totalRowsDumped++;
                    $valStrings = [];
                    foreach ($row as $v) {
                        if ($v === null) {
                            $valStrings[] = 'NULL';
                        } elseif (is_int($v) || is_float($v)) {
                            $valStrings[] = (string)$v;
                        } else {
                            $valStrings[] = $pdo->quote($v);
                        }
                    }
                    $chunk[] = '(' . implode(', ', $valStrings) . ')';
                    if (count($chunk) >= 100) {
                        $output .= "INSERT INTO `{$safeT}` ({$colList}) VALUES\n" . implode(",\n", $chunk) . ";\n\n";
                        $chunk = [];
                        $flush();
                    }
                }
                if (!empty($chunk)) {
                    $output .= "INSERT INTO `{$safeT}` ({$colList}) VALUES\n" . implode(",\n", $chunk) . ";\n\n";
                }
            }
            } finally {
                $rowsStmt->closeCursor();
                $pdo->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, true);
            }
        }
        $flush();
    }

    // Everything below is schema, not data. The order follows
    // mysqldump: triggers after the data they'd otherwise fire on,
    // routines before views (a view may call a stored function),
    // and views last so every table they select from already exists.
    $clean = function ($sql) use ($keepDefiner) {
        return $keepDefiner ? $sql : stripDefiner($sql);
    };
    $section = function ($title) {
        return "-- --------------------------------------------------------\n"
             . "-- {$title}\n"
             . "-- --------------------------------------------------------\n\n";
    };

    if ($withStructure && $includeRoutines && !empty($baseTables)) {
        $wanted = array_flip($baseTables);
        try {
            $trgStmt = $pdo->prepare("SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER");
            $trgStmt->execute([$rawDb]);
        } catch (Exception $e) {
            // ACTION_ORDER is missing on very old servers.
            $trgStmt = $pdo->prepare("SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY EVENT_OBJECT_TABLE");
            $trgStmt->execute([$rawDb]);
        }
        foreach ($trgStmt->fetchAll(PDO::FETCH_ASSOC) as $trg) {
            if (!isset($wanted[$trg['EVENT_OBJECT_TABLE']])) continue;
            $name = $trg['TRIGGER_NAME'];
            $safeName = escapeId($name);
            $row = $pdo->query("SHOW CREATE TRIGGER `{$safeName}`")->fetch(PDO::FETCH_ASSOC);
            $output .= $section("Trigger `{$name}` on table `{$trg['EVENT_OBJECT_TABLE']}`");
            if (empty($row['SQL Original Statement'])) {
                $output .= "-- Skipped: insufficient privileges to read this trigger.\n\n";
                continue;
            }
            if ($addDropTable) $output .= "DROP TRIGGER IF EXISTS `{$safeName}`;\n";
            $output .= "DELIMITER ;;\n" . $clean($row['SQL Original Statement']) . ";;\nDELIMITER ;\n\n";
        }
    }

    // Routines and events belong to the database, not a table.
    if ($withStructure && $includeRoutines && empty($singleTable)) {
        $rStmt = $pdo->prepare("SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME");
        $rStmt->execute([$rawDb]);
        foreach ($rStmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $kind = strtoupper($r['ROUTINE_TYPE']) === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE';
            $name = $r['ROUTINE_NAME'];
            $safeName = escapeId($name);
            $key = $kind === 'FUNCTION' ? 'Create Function' : 'Create Procedure';
            $output .= $section(ucfirst(strtolower($kind)) . " `{$name}`");
            try {
                $row = $pdo->query("SHOW CREATE {$kind} `{$safeName}`")->fetch(PDO::FETCH_ASSOC);
            } catch (Exception $e) {
                $row = [];
            }
            // The body comes back NULL when we lack privileges on it.
            if (empty($row[$key])) {
                $output .= "-- Skipped: insufficient privileges to read this routine.\n\n";
                continue;
            }
            if ($addDropTable) $output .= "DROP {$kind} IF EXISTS `{$safeName}`;\n";
            $output .= "DELIMITER ;;\n" . $clean($row[$key]) . ";;\nDELIMITER ;\n\n";
        }

        try {
            $eStmt = $pdo->prepare("SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME");
            $eStmt->execute([$rawDb]);
            $events = $eStmt->fetchAll(PDO::FETCH_COLUMN);
        } catch (Exception $e) {
            $events = []; // needs the EVENT privilege
        }
        foreach ($events as $name) {
            $safeName = escapeId($name);
            $output .= $section("Event `{$name}`");
            try {
                $row = $pdo->query("SHOW CREATE EVENT `{$safeName}`")->fetch(PDO::FETCH_ASSOC);
            } catch (Exception $e) {
                $row = [];
            }
            if (empty($row['Create Event'])) {
                $output .= "-- Skipped: insufficient privileges to read this event.\n\n";
                continue;
            }
            if ($addDropTable) $output .= "DROP EVENT IF EXISTS `{$safeName}`;\n";
            $output .= "DELIMITER ;;\n" . $clean($row['Create Event']) . ";;\nDELIMITER ;\n\n";
        }
    }

    if ($withStructure && !empty($views)) {
        $viewDefs = [];
        foreach ($views as $v) {
            $row = $pdo->query("SHOW CREATE VIEW `" . escapeId($v) . "`")->fetch(PDO::FETCH_ASSOC);
            if (empty($row['Create View'])) continue;
            // MySQL stores view bodies fully qualified (`db`.`t`).
            // Drop the qualifier for this database so the dump can be
            // imported into a database with a different name.
            $viewDefs[$v] = str_replace('`' . escapeId($rawDb) . '`.', '', $clean($row['Create View']));
        }
        foreach (orderViewsByDependency($viewDefs) as $v) {
            $safeV = escapeId($v);
            $output .= $section("Structure for view `{$v}`");
            if ($addDropTable) $output .= "DROP VIEW IF EXISTS `{$safeV}`;\n";
            $output .= $viewDefs[$v] . ";\n\n";
        }
    }

    if ($disableFk) {
        $output .= "\nSET FOREIGN_KEY_CHECKS = 1;\n";
    }
    $output .= "-- Dump completed on " . date('Y-m-d H:i:s') . "\n";
    $flush(true);

    return [$emit ? '' : $output, $totalRowsDumped];
}

// The uploaded import file as [text, file name]. A gzip file (.sql.gz from Export
// with "Compress") is unpacked, and ".gz" is dropped from the name so the format
// is still recognised from "x.sql".
function readUploadedFile() {
    $name = (string)$_FILES['file']['name'];
    $content = file_get_contents($_FILES['file']['tmp_name']);
    if ($content !== false && strncmp($content, "\x1f\x8b", 2) === 0) {
        if (!function_exists('gzdecode')) throw new Exception('This server cannot unpack .gz files (PHP zlib is missing). Unzip it first.');
        $plain = @gzdecode($content);
        if ($plain === false) throw new Exception('This .gz file is damaged or incomplete.');
        $content = $plain;
        $name = preg_replace('/\.gz$/i', '', $name);
    }
    return [(string)$content, $name];
}

// Starts a file download that is written while it is being built (no Content-Length),
// so a 1 GB export never has to fit in memory. Returns a function that sends a piece.
// The optional $token comes back as a short-lived cookie so the page can tell the
// download has started (a download in a hidden frame fires no event of its own).
function startDownload($filename, $contentType, $token = '', $gzip = false) {
    if ($gzip && !function_exists('deflate_init')) {
        throw new Exception('This server cannot compress (PHP zlib is missing). Untick "Compress" and try again.');
    }
    @set_time_limit(0);
    // Free the session lock, or every other request from this browser waits for the download.
    if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
    while (ob_get_level() > 0) @ob_end_clean();
    if (function_exists('apache_setenv')) @apache_setenv('no-gzip', '1');
    @ini_set('zlib.output_compression', '0');
    if ($gzip) {
        // A .gz file the browser saves as-is (no Content-Encoding, which it would undo).
        $contentType = 'application/gzip';
        $filename .= '.gz';
    }
    header('Content-Type: ' . $contentType);
    header('Content-Disposition: attachment; filename="' . str_replace(['"', "\r", "\n"], '', $filename) . '"');
    header('Cache-Control: no-store');
    header('X-Accel-Buffering: no'); // nginx: pass pieces on instead of collecting the whole file
    if ($token !== '' && preg_match('/^[A-Za-z0-9_-]{1,64}$/', $token)) {
        setcookie('dbm_dl', $token, ['expires' => time() + 120, 'path' => '/', 'samesite' => 'Lax']);
    }
    if (!$gzip) {
        return function ($chunk) {
            echo $chunk;
            flush();
        };
    }
    // Compressed on the fly, piece by piece; the gzip ending is written when the
    // script ends (also after an error or exit), so the .gz file is always valid.
    $ctx = deflate_init(ZLIB_ENCODING_GZIP, ['level' => 6]);
    register_shutdown_function(function () use ($ctx) {
        echo deflate_add($ctx, '', ZLIB_FINISH);
        flush();
    });
    return function ($chunk) use ($ctx) {
        $out = deflate_add($ctx, $chunk, ZLIB_NO_FLUSH);
        if ($out !== '') {
            echo $out;
            flush();
        }
    };
}

// Runs a multi-statement SQL script (DELIMITER-aware), one statement at a
// time. Stops at the first error unless $continueOnError. Used by the import
// action and by backup restore.
function runSqlScript($pdo, $content, $disableFk, $continueOnError) {
    if ($disableFk) {
        $pdo->exec("SET FOREIGN_KEY_CHECKS = 0");
    }
    $queries = splitSqlStatements($content);
    $executed = 0;
    $affectedTotal = 0;
    $errors = [];
    try {
        foreach ($queries as $idx => $q) {
            $clean = trim($q);
            if ($clean === '' || $clean === ';') continue;
            try {
                $stmt = $pdo->query($clean);
                $executed++;
                if ($stmt) {
                    $affectedTotal += $stmt->rowCount();
                }
            } catch (Exception $qe) {
                $errors[] = [
                    'query_index' => $idx + 1,
                    'error' => $qe->getMessage(),
                    'snippet' => mb_substr($clean, 0, 140)
                ];
                if (!$continueOnError) {
                    break;
                }
            }
        }
    } finally {
        if ($disableFk) {
            $pdo->exec("SET FOREIGN_KEY_CHECKS = 1");
        }
    }
    return ['queries' => $queries, 'executed' => $executed, 'affected' => $affectedTotal, 'errors' => $errors];
}

// True for an ENUM/SET value list like 'a','b c','it''s' (quotes doubled or
// backslash-escaped inside values). Anything else could inject SQL.
function isQuotedValueList($s) {
    $n = strlen($s);
    $i = 0;
    while (true) {
        while ($i < $n && ctype_space($s[$i])) $i++;
        if ($i >= $n || $s[$i] !== "'") return false;
        $i++;
        while (true) {
            if ($i >= $n) return false;                       // unterminated value
            if ($s[$i] === '\\') { $i += 2; continue; }        // backslash escape
            if ($s[$i] === "'") {
                if ($i + 1 < $n && $s[$i + 1] === "'") { $i += 2; continue; } // '' inside a value
                $i++;
                break;
            }
            $i++;
        }
        while ($i < $n && ctype_space($s[$i])) $i++;
        if ($i === $n) return true;
        if ($s[$i] !== ',') return false;
        $i++;
    }
}

// A column's full definition ("int unsigned NOT NULL DEFAULT '0' COMMENT '…'")
// taken from SHOW CREATE TABLE output, or null if the column isn't there.
// Used to move a column without changing anything else about it.
function columnDefinition($createSql, $col) {
    $prefix = '  `' . escapeId($col) . '` ';
    foreach (preg_split('/\r?\n/', (string)$createSql) as $line) {
        if (strpos($line, $prefix) === 0) return rtrim(substr($line, strlen($prefix)), " ,");
    }
    return null;
}

// Group KEY_COLUMN_USAGE rows (one per column) into one entry per constraint.
function groupForeignKeys(array $rows) {
    $out = [];
    foreach ($rows as $r) {
        $k = $r['schema'] . "\0" . $r['tbl'] . "\0" . $r['name'];
        if (!isset($out[$k])) {
            $out[$k] = [
                'name' => $r['name'], 'schema' => $r['schema'], 'table' => $r['tbl'], 'columns' => [],
                'ref_schema' => $r['ref_schema'], 'ref_table' => $r['ref_table'], 'ref_columns' => [],
                'on_update' => $r['on_update'], 'on_delete' => $r['on_delete']
            ];
        }
        $out[$k]['columns'][] = $r['col'];
        $out[$k]['ref_columns'][] = $r['ref_col'];
    }
    return array_values($out);
}

// Server-side backups are kept OUTSIDE the web root (the folder next to this
// project) so the web server can never hand a database dump to a browser.
// Change this path if that location isn't writable or you want them elsewhere.
// This file lives in <project>/php/, so two levels up is the folder next to the project.
define('BACKUP_DIR', dirname(__DIR__, 2) . DIRECTORY_SEPARATOR . 'dbmanager-backups');

// Folder holding one database's backups. Includes a hash of the server so two
// servers with a database of the same name don't share backups.
function backupDirFor($rawDb) {
    $server = ($_SESSION['db_host'] ?? '') . ':' . ($_SESSION['db_port'] ?? '');
    $safe = preg_replace('/[^A-Za-z0-9_-]/', '_', $rawDb);
    return BACKUP_DIR . DIRECTORY_SEPARATOR . $safe . '_' . substr(md5($server . '|' . $rawDb), 0, 8);
}

// A backup file name we created ourselves; anything else (paths, ..) is refused.
function backupFilePath($rawDb, $file) {
    $file = (string)$file;
    if (!preg_match('/^\d{4}-\d{2}-\d{2}_\d{6}(_\d+)?\.sql$/', $file)) {
        throw new Exception('Invalid backup file name.');
    }
    $path = backupDirFor($rawDb) . DIRECTORY_SEPARATOR . $file;
    if (!is_file($path)) throw new Exception('That backup no longer exists.');
    return $path;
}

// Reject state-changing requests that don't carry a valid CSRF token. Read-only
// actions (databases/tables/data/export/... all GET or side-effect-free) are
// intentionally excluded so the GET export-download still works. run_query can
// mutate, so it is protected; the frontend always attaches the token to POSTs.
$STATE_CHANGING = [
    'connect', 'update_cell', 'delete_row', 'insert_row', 'drop_column',
    'add_index', 'edit_index', 'drop_index', 'save_column', 'run_query',
    'import', 'logout',
    'create_table', 'rename_table', 'duplicate_table', 'truncate_tables', 'drop_tables',
    'drop_object', 'backup_create', 'backup_restore', 'backup_delete', 'fix_view_definer',
    'add_foreign_key', 'drop_foreign_key', 'move_column'
];
if (in_array($action, $STATE_CHANGING, true)) {
    $sentToken = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (!is_string($sentToken) || $sentToken === '' || !hash_equals($_SESSION['csrf_token'], $sentToken)) {
        http_response_code(403);
        echo json_encode([
            'success' => false,
            'error' => 'Invalid or missing security token. Please reload the page and try again.'
        ]);
        exit;
    }
}

try {
    switch ($action) {
        case 'connect':
            // Throttle repeated failed logins to blunt brute-forcing of DB
            // credentials. Counter lives in the session; the constant delay on
            // failure also slows cookie-less scripted guessing.
            $now = time();
            if (!empty($_SESSION['login_lock_until']) && $now < $_SESSION['login_lock_until']) {
                $wait = $_SESSION['login_lock_until'] - $now;
                throw new Exception("Too many failed attempts. Please wait {$wait}s before trying again.", 429);
            }

            $hostInput = $input['host'] ?? 'localhost:3306';
            $hostParts = explode(':', $hostInput);
            $host = $hostParts[0] ?: 'localhost';
            $port = (isset($hostParts[1]) && $hostParts[1] !== '') ? $hostParts[1] : '3306';

            $_SESSION['db_host'] = $host;
            $_SESSION['db_port'] = $port;
            $_SESSION['db_user'] = $input['user'] ?? 'root';
            $_SESSION['db_pass'] = $input['password'] ?? '';
            $_SESSION['db_name'] = $input['database'] ?? '';

            // Test connection
            try {
                $pdo = getDB();
            } catch (Exception $connErr) {
                // Don't leave the rejected credentials sitting in the session.
                unset($_SESSION['db_host'], $_SESSION['db_port'], $_SESSION['db_user'], $_SESSION['db_pass'], $_SESSION['db_name']);
                $fails = ($_SESSION['login_fails'] ?? 0) + 1;
                $_SESSION['login_fails'] = $fails;
                if ($fails >= 5) {
                    // Escalating lockout after 5 strikes, capped at 5 minutes.
                    $_SESSION['login_lock_until'] = time() + min(300, 30 * ($fails - 4));
                }
                usleep(400000); // ~0.4s constant penalty on every failure
                throw new Exception('Connection failed. Check your host, credentials, and that the server is reachable.');
            }

            // Success: clear throttle state and rotate the session id to defeat
            // session fixation now that the session is authenticated.
            unset($_SESSION['login_fails'], $_SESSION['login_lock_until']);
            session_regenerate_id(true);

            echo json_encode([
                'success' => true,
                'message' => 'Connected successfully',
                'csrf' => $_SESSION['csrf_token']
            ]);
            break;

        case 'databases':
            $pdo = getDB();
            $stmt = $pdo->query('SHOW DATABASES');
            $databases = [];
            while ($row = $stmt->fetch(PDO::FETCH_NUM)) {
                $databases[] = $row[0];
            }
            echo json_encode(['databases' => $databases]);
            break;

        case 'tables':
            $pdo = getDB();
            $db = escapeId($_GET['db'] ?? '');
            if (!$db) throw new Exception('Database name is required');
            // `tables` keeps listing every object (views included) so existing
            // callers are unaffected; `views` lets the sidebar mark which are views.
            $tables = [];
            $views = [];
            foreach (tableTypes($pdo, $db) as $name => $type) {
                $tables[] = $name;
                if ($type === 'VIEW') $views[] = $name;
            }
            echo json_encode(['tables' => $tables, 'views' => $views]);
            break;

        case 'data':
            $pdo = getDB();
            $rawDb = $_GET['db'] ?? '';
            $rawTable = $_GET['table'] ?? '';
            if (!$rawDb || !$rawTable) throw new Exception('Database and table name are required');

            $db = escapeId($rawDb);
            $table = escapeId($rawTable);

            // 1. Pagination parameters
            $page = max(1, isset($_GET['page']) ? (int)$_GET['page'] : 1);
            $perPage = max(1, isset($_GET['per_page']) ? (int)$_GET['per_page'] : 25);
            $offset = ($page - 1) * $perPage;
            $limitSql = "LIMIT $perPage OFFSET $offset";

            $filters = isset($_GET['filters']) ? json_decode($_GET['filters'], true) : [];
            $sorts = isset($_GET['sorts']) ? json_decode($_GET['sorts'], true) : [];
            if (!is_array($filters)) $filters = [];
            if (!is_array($sorts)) $sorts = [];

            $pdo->exec("USE `$db`");

            // Relationship columns: needed for the "fk" filter below and for labels.
            $fkMeta = [];
            try {
                $fkMeta = fkMeta($pdo, $rawDb, $rawTable);
            } catch (Exception $fkErr) {
                // Without FK info the grid still works, just with raw IDs.
            }

            // 2. Build the WHERE clause. Quick filters (the filter row; ids start
            // with "qcol_") always combine with AND. The filter bar's conditions
            // combine with AND or OR ("match all / any") and are then ANDed on.
            $matchAny = (($_GET['match'] ?? 'all') === 'any');
            $quickParts = [];
            $quickParams = [];
            $advParts = [];
            $advParams = [];
            // "contains" must treat % and _ as text, not as LIKE wildcards.
            $like = function ($v) {
                return addcslashes((string)$v, '\\%_');
            };
            foreach ($filters as $f) {
                if (!is_array($f) || empty($f['active']) || empty($f['col']) || empty($f['op'])) continue;
                $col = escapeId($f['col']);
                // fn "date": compare only the date part of a DATETIME/TIMESTAMP column.
                $expr = (($f['fn'] ?? '') === 'date') ? "DATE(`$col`)" : "`$col`";
                $val = $f['val'] ?? '';
                if (is_array($val)) continue;
                $p = [];
                switch ($f['op']) {
                    case '=':
                    case '>':
                    case '<':
                    case '>=':
                    case '<=':
                        $sql = "$expr {$f['op']} ?";
                        $p[] = $val;
                        break;
                    case '!=':
                        // "is not X" should also find rows where it's NULL.
                        $sql = "($expr IS NULL OR $expr != ?)";
                        $p[] = $val;
                        break;
                    case 'contains':
                        $sql = "$expr LIKE ?";
                        $p[] = '%' . $like($val) . '%';
                        break;
                    case 'not contains':
                        $sql = "($expr IS NULL OR $expr NOT LIKE ?)";
                        $p[] = '%' . $like($val) . '%';
                        break;
                    case 'starts with':
                        $sql = "$expr LIKE ?";
                        $p[] = $like($val) . '%';
                        break;
                    case 'ends with':
                        $sql = "$expr LIKE ?";
                        $p[] = '%' . $like($val);
                        break;
                    case 'between':
                        $sql = "$expr BETWEEN ? AND ?";
                        $p[] = $val;
                        $p[] = $f['val2'] ?? '';
                        break;
                    case 'is null':
                        $sql = "$expr IS NULL";
                        break;
                    case 'is not null':
                        $sql = "$expr IS NOT NULL";
                        break;
                    case 'is empty':
                        $sql = "($expr IS NULL OR $expr = '')";
                        break;
                    case 'is not empty':
                        $sql = "($expr IS NOT NULL AND $expr <> '')";
                        break;
                    case 'fk':
                        // Relationship column: match the stored ID, or any
                        // referenced row whose name contains the text.
                        $fk = $fkMeta[$f['col']] ?? null;
                        if ($fk && $fk['label'] !== null) {
                            $src = '`' . escapeId($fk['schema']) . '`.`' . escapeId($fk['table']) . '`';
                            $ref = escapeId($fk['column']);
                            $lab = escapeId($fk['label']);
                            $sql = "($expr = ? OR $expr IN (SELECT `$ref` FROM $src WHERE `$lab` LIKE ?))";
                            $p[] = $val;
                            $p[] = '%' . $like($val) . '%';
                        } else {
                            $sql = "$expr = ?";
                            $p[] = $val;
                        }
                        break;
                    default:
                        continue 2; // unknown operator: ignore the condition
                }
                if (strpos((string)($f['id'] ?? ''), 'qcol_') === 0) {
                    $quickParts[] = $sql;
                    array_push($quickParams, ...$p);
                } else {
                    $advParts[] = $sql;
                    array_push($advParams, ...$p);
                }
            }
            $whereParts = $quickParts;
            $params = $quickParams;
            if ($advParts) {
                $whereParts[] = '(' . implode($matchAny ? ' OR ' : ' AND ', $advParts) . ')';
                $params = array_merge($params, $advParams);
            }
            $whereSql = count($whereParts) > 0 ? "WHERE " . implode(" AND ", $whereParts) : "";

            // 3. Build Dynamic ORDER BY Clause
            $orderParts = [];
            foreach ($sorts as $s) {
                if (empty($s['col'])) continue;
                $col = escapeId($s['col']);
                $dir = (isset($s['dir']) && strtoupper($s['dir']) === 'DESC') ? 'DESC' : 'ASC';
                $orderParts[] = "`$col` $dir";
            }
            $orderSql = count($orderParts) > 0 ? "ORDER BY " . implode(", ", $orderParts) : "";

            // 4. Get total count
            $countStmt = $pdo->prepare("SELECT COUNT(*) FROM `$table` $whereSql");
            $countStmt->execute($params);
            $totalRows = (int)$countStmt->fetchColumn();

            // 5. Fetch Schema
            $stmtSchema = $pdo->query("SHOW FULL COLUMNS FROM `$table`");
            $schema = $stmtSchema->fetchAll(PDO::FETCH_ASSOC);

            // 6. Fetch paginated data
            $sqlData = "SELECT * FROM `$table` $whereSql $orderSql $limitSql";
            $stmtData = $pdo->prepare($sqlData);
            $stmtData->execute($params);
            $data = $stmtData->fetchAll(PDO::FETCH_ASSOC);

            // 7. Names for the relationship values on this page (any number of
            // referenced rows, not just the first 100). The picker searches the
            // rest on demand through fk_options.
            $fkLabelsOut = [];
            foreach ($fkMeta as $colName => $fk) {
                try {
                    $fkLabelsOut[$colName] = (object)fkLabels($pdo, $fk, array_column($data, $colName));
                } catch (Exception $fkErr) {
                    // Leave this column without labels; it shows raw IDs.
                }
            }

            echo json_encode([
                'schema' => $schema,
                'data' => $data,
                'totalRows' => $totalRows,
                'fk_meta' => (object)$fkMeta,
                'fk_labels' => (object)$fkLabelsOut
            ]);
            break;

        case 'fk_options':
            // Search the rows a relationship column can point at, for the picker.
            // The target comes from the schema, never from the request.
            $pdo = getDB();
            $rawDb = $_GET['db'] ?? '';
            $rawTable = $_GET['table'] ?? '';
            $column = $_GET['column'] ?? '';
            if ($rawDb === '' || $rawTable === '' || $column === '') {
                throw new Exception('Database, table and column are required.');
            }
            $fk = fkMeta($pdo, $rawDb, $rawTable)[$column] ?? null;
            if (!$fk) throw new Exception("Column \"$column\" is not a foreign key.");

            $q = trim((string)($_GET['q'] ?? ''));
            $limit = 50;
            $ref = '`' . escapeId($fk['column']) . '`';
            $label = $fk['label'] !== null ? '`' . escapeId($fk['label']) . '`' : $ref;
            $src = '`' . escapeId($fk['schema']) . '`.`' . escapeId($fk['table']) . '`';

            $where = '';
            $order = "ORDER BY $ref";
            $params = [];
            if ($q !== '') {
                $where = "WHERE CAST($ref AS CHAR) = ? OR CAST($ref AS CHAR) LIKE ?" . ($fk['label'] !== null ? " OR $label LIKE ?" : '');
                $params = [$q, "$q%"];
                if ($fk['label'] !== null) $params[] = "%$q%";
                // Exact ID first, then IDs starting with the text, then name matches.
                $order = "ORDER BY (CAST($ref AS CHAR) = ?) DESC, (CAST($ref AS CHAR) LIKE ?) DESC, $label";
                $params[] = $q;
                $params[] = "$q%";
            }
            $stmt = $pdo->prepare("SELECT $ref AS val, $label AS label FROM $src $where $order LIMIT " . ($limit + 1));
            $stmt->execute($params);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            echo json_encode([
                'success' => true,
                'meta' => $fk,
                'options' => array_slice($rows, 0, $limit),
                'has_more' => count($rows) > $limit
            ]);
            break;

        case 'update_cell':
            $pdo = getDB();
            $db = escapeId($input['db'] ?? '');
            $table = escapeId($input['table'] ?? '');
            $column = escapeId($input['column'] ?? '');
            $value = $input['value'] ?? null;
            $pk_col = escapeId($input['pk_col'] ?? '');
            $pk_val = $input['pk_val'] ?? null;
            // Optional: the whole primary key as {column: value}, for keys of more than one column.
            $pkMap = (isset($input['pk']) && is_array($input['pk'])) ? $input['pk'] : null;

            if (!$db || !$table || !$column || (!$pk_col && !$pkMap)) {
                throw new Exception("Missing parameters for cell update");
            }

            $pdo->exec("USE `$db`");

            // Normalize empty string for nullable or numeric columns to prevent SQL 1366
            if ($value === '') {
                $rawCol = str_replace('``', '`', $column);
                $colStmt = $pdo->prepare("SHOW COLUMNS FROM `$table` LIKE ?");
                $colStmt->execute([$rawCol]);
                $colInfo = $colStmt->fetch();
                if ($colInfo) {
                    if ($colInfo['Null'] === 'YES') {
                        $value = null;
                    } elseif (preg_match('/(int|decimal|float|double|bit|numeric)/i', $colInfo['Type'])) {
                        $value = ($colInfo['Default'] !== null) ? $colInfo['Default'] : 0;
                    }
                }
            }

            if ($pkMap) {
                $where = [];
                $params = [$value];
                foreach ($pkMap as $k => $v) {
                    if (!is_string($k) || $k === '') throw new Exception('Invalid primary key.');
                    $where[] = '`' . escapeId($k) . '` = ?';
                    $params[] = $v;
                }
                // LIMIT 1: a key always matches at most one row; this guards against a wrong key.
                $stmt = $pdo->prepare("UPDATE `$table` SET `$column` = ? WHERE " . implode(' AND ', $where) . " LIMIT 1");
                $stmt->execute($params);
            } else {
                $stmt = $pdo->prepare("UPDATE `$table` SET `$column` = ? WHERE `$pk_col` = ?");
                $stmt->execute([$value, $pk_val]);
            }

            echo json_encode(['success' => true, 'affected' => $stmt->rowCount()]);
            break;

        case 'delete_row':
            $pdo = getDB();
            $db = escapeId($input['db'] ?? '');
            $table = escapeId($input['table'] ?? '');
            $pk_col = escapeId($input['pk_col'] ?? '');
            $pk_val = $input['pk_val'] ?? null;

            if (!$db || !$table || !$pk_col) {
                throw new Exception("Missing parameters for row deletion");
            }

            $pdo->exec("USE `$db`");
            $stmt = $pdo->prepare("DELETE FROM `$table` WHERE `$pk_col` = ?");
            $stmt->execute([$pk_val]);

            echo json_encode(['success' => true]);
            break;

        case 'insert_row':
            $pdo = getDB();
            $db = escapeId($input['db'] ?? '');
            $table = escapeId($input['table'] ?? '');
            $data = $input['data'] ?? [];

            if (!$db || !$table || !is_array($data) || empty($data)) {
                throw new Exception("Missing parameters for row insertion");
            }

            $pdo->exec("USE `$db`");

            // Normalize empty values for columns to prevent SQL 1366
            $colsDesc = $pdo->query("SHOW COLUMNS FROM `$table`")->fetchAll();
            $colsMap = [];
            foreach ($colsDesc as $cd) {
                $colsMap[$cd['Field']] = $cd;
            }

            foreach ($data as $k => $v) {
                if ($v === '' && isset($colsMap[$k])) {
                    $cMeta = $colsMap[$k];
                    if ($cMeta['Null'] === 'YES') {
                        $data[$k] = null;
                    } elseif (preg_match('/(int|decimal|float|double|bit|numeric)/i', $cMeta['Type'])) {
                        $data[$k] = ($cMeta['Default'] !== null) ? $cMeta['Default'] : 0;
                    }
                }
            }

            $cols = array_keys($data);
            $vals = array_values($data);

            $escapedCols = array_map('escapeId', $cols);
            $colNames = implode("`, `", $escapedCols);
            $placeholders = implode(",", array_fill(0, count($cols), "?"));

            $stmt = $pdo->prepare("INSERT INTO `$table` (`$colNames`) VALUES ($placeholders)");
            $stmt->execute($vals);

            echo json_encode(['success' => true, 'insertId' => $pdo->lastInsertId()]);
            break;

        case 'drop_column':
            $pdo = getDB();
            $db = escapeId($input['db'] ?? '');
            $table = escapeId($input['table'] ?? '');
            $col = escapeId($input['col_name'] ?? '');

            if (!$db || !$table || !$col) throw new Exception("Missing parameters to drop column");

            $pdo->exec("USE `$db`");
            $pdo->exec("ALTER TABLE `$table` DROP COLUMN `$col`");
            echo json_encode(['success' => true]);
            break;

        case 'add_index':
            $pdo = getDB();
            $db = escapeId($input['db'] ?? '');
            $table = escapeId($input['table'] ?? '');
            $colsRaw = $input['cols'] ?? $input['col_name'] ?? '';
            $colList = is_array($colsRaw) ? $colsRaw : array_filter(array_map('trim', explode(',', (string)$colsRaw)));
            $type = strtoupper($input['index_type'] ?? 'INDEX');
            $customName = !empty($input['index_name']) ? escapeId(trim($input['index_name'])) : '';

            if (!$db || !$table || empty($colList)) {
                throw new Exception("Missing required index parameters.");
            }

            $colSqlParts = array_map(function($c) { return '`' . escapeId($c) . '`'; }, $colList);
            $colSql = implode(', ', $colSqlParts);
            $firstCol = escapeId($colList[0]);

            $pdo->exec("USE `$db`");

            if ($type === 'PRIMARY') {
                $sql = "ALTER TABLE `$table` ADD PRIMARY KEY ($colSql)";
            } elseif ($type === 'UNIQUE') {
                $idxName = $customName ?: "{$firstCol}_unique_" . time();
                $sql = "ALTER TABLE `$table` ADD UNIQUE `$idxName` ($colSql)";
            } else {
                $idxName = $customName ?: "{$firstCol}_idx_" . time();
                $sql = "ALTER TABLE `$table` ADD INDEX `$idxName` ($colSql)";
            }

            $pdo->exec($sql);
            echo json_encode(['success' => true]);
            break;

        case 'edit_index':
            $pdo = getDB();
            $db = escapeId($input['db'] ?? '');
            $table = escapeId($input['table'] ?? '');
            $oldKey = escapeId($input['old_key_name'] ?? '');
            $newKey = !empty($input['new_key_name']) ? escapeId(trim($input['new_key_name'])) : '';
            $colsRaw = $input['cols'] ?? $input['col_name'] ?? '';
            $colList = is_array($colsRaw) ? $colsRaw : array_filter(array_map('trim', explode(',', (string)$colsRaw)));
            $type = strtoupper($input['index_type'] ?? 'INDEX');

            if (!$db || !$table || !$oldKey || empty($colList)) {
                throw new Exception("Missing required edit index parameters.");
            }

            $colSqlParts = array_map(function($c) { return '`' . escapeId($c) . '`'; }, $colList);
            $colSql = implode(', ', $colSqlParts);
            $firstCol = escapeId($colList[0]);

            $pdo->exec("USE `$db`");

            $dropSql = ($oldKey === 'PRIMARY') ? "DROP PRIMARY KEY" : "DROP INDEX `$oldKey`";

            if ($type === 'PRIMARY') {
                $addSql = "ADD PRIMARY KEY ($colSql)";
            } elseif ($type === 'UNIQUE') {
                $idxName = $newKey ?: "{$firstCol}_unique_" . time();
                $addSql = "ADD UNIQUE `$idxName` ($colSql)";
            } else {
                $idxName = $newKey ?: "{$firstCol}_idx_" . time();
                $addSql = "ADD INDEX `$idxName` ($colSql)";
            }

            $sql = "ALTER TABLE `$table` $dropSql, $addSql";
            $pdo->exec($sql);
            echo json_encode(['success' => true]);
            break;

        case 'run_query':
            $pdo = getDB();
            $sql = trim($input['query'] ?? '');
            $db = !empty($input['db']) ? escapeId($input['db']) : '';
            $page = max(1, isset($input['page']) ? (int)$input['page'] : 1);
            $perPage = max(1, isset($input['per_page']) ? (int)$input['per_page'] : 25);
            $offset = ($page - 1) * $perPage;

            if ($db) $pdo->exec("USE `$db`");
            if (empty($sql)) throw new Exception('SQL query cannot be empty.');

            // Strip trailing semicolons
            $cleanSql = rtrim($sql, "; \t\n\r\0\x0B");

            // Strip comments and find the leading SQL verb
            $cleanForVerb = preg_replace('/(\/\*.*?\*\/|--[^\r\n]*|#[^\r\n]*)/s', '', $cleanSql);
            $cleanForVerb = trim($cleanForVerb);
            $verb = '';
            if (preg_match('/^([a-zA-Z]+)/', $cleanForVerb, $matches)) {
                $verb = strtoupper($matches[1]);
            }

            $isSelect = in_array($verb, ['SELECT', 'WITH']);
            $isRowReturning = in_array($verb, ['SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'CHECK', 'ANALYZE', 'OPTIMIZE']);
            $hasExistingLimit = preg_match('/\bLIMIT\s+\d+/i', $cleanSql);

            $data = [];
            $headers = [];
            $totalRows = 0;
            $message = null;
            $affected = null;
            $insertId = null;
            $started = microtime(true);

            // Everything appended to the user's SQL starts on a new line: a query
            // ending in "-- comment" would otherwise swallow it (and an unlimited
            // SELECT could pull a whole table).
            if ($isSelect) {
                // For SELECT: Attempt to count total rows for pagination
                if (!$hasExistingLimit) {
                    try {
                        $countSql = "SELECT COUNT(*) FROM ($cleanSql\n) AS _total";
                        $totalRows = (int)$pdo->query($countSql)->fetchColumn();
                    } catch (Exception $e) {
                        // ignore count error
                    }
                }

                $canPaginate = !$hasExistingLimit;
                $queryToRun = $canPaginate ? "$cleanSql\nLIMIT $perPage OFFSET $offset" : $cleanSql;
                $stmt = $pdo->query($queryToRun);

                if ($stmt->columnCount() > 0) {
                    for ($i = 0; $i < $stmt->columnCount(); $i++) {
                        $meta = $stmt->getColumnMeta($i);
                        $headers[] = $meta['name'];
                    }
                    $data = $stmt->fetchAll(PDO::FETCH_NUM);
                }

                if (!$canPaginate) {
                    $totalRows = count($data);
                }
            } elseif ($isRowReturning) {
                // For SHOW, DESCRIBE, EXPLAIN etc.
                $stmt = $pdo->query($cleanSql);
                if ($stmt->columnCount() > 0) {
                    for ($i = 0; $i < $stmt->columnCount(); $i++) {
                        $meta = $stmt->getColumnMeta($i);
                        $headers[] = $meta['name'];
                    }
                    $data = $stmt->fetchAll(PDO::FETCH_NUM);
                }
                $totalRows = count($data);
            } else {
                // DDL / DML commands (INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, TRUNCATE, etc.)
                $stmt = $pdo->query($cleanSql);
                $affected = $stmt ? $stmt->rowCount() : 0;
                $totalRows = 0;
                $message = "Query OK. Affected rows: $affected";
                if (in_array($verb, ['INSERT', 'REPLACE'], true)) {
                    $id = $pdo->lastInsertId();
                    if ($id !== '0' && $id !== false) $insertId = $id;
                }
            }

            echo json_encode([
                'success' => true,
                'data' => $data,
                'headers' => $headers,
                'totalRows' => $totalRows,
                'message' => $message,
                'verb' => $verb,
                'affected' => $affected,
                'insert_id' => $insertId,
                'paginated' => $isSelect && !$hasExistingLimit,
                'time_ms' => round((microtime(true) - $started) * 1000, 1)
            ]);
            break;

        case 'db_columns':
            // Every table's columns in a database, for SQL autocomplete.
            $pdo = getDB();
            $rawDb = $_GET['db'] ?? '';
            if ($rawDb === '') throw new Exception('Database name is required.');
            $stmt = $pdo->prepare("SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION");
            $stmt->execute([$rawDb]);
            $tables = [];
            foreach ($stmt->fetchAll(PDO::FETCH_NUM) as [$t, $c]) $tables[$t][] = $c;
            echo json_encode(['success' => true, 'tables' => (object)$tables]);
            break;

        case 'get_indexes':
            $pdo = getDB();
            $db = escapeId($_GET['db'] ?? '');
            $table = escapeId($_GET['table'] ?? '');
            if (!$db || !$table) throw new Exception("Missing parameters for indexes");
            $pdo->exec("USE `$db`");
            $stmt = $pdo->query("SHOW INDEX FROM `$table`");
            echo json_encode(['indexes' => $stmt->fetchAll()]);
            break;

        case 'drop_index':
            $pdo = getDB();
            $db = escapeId($input['db'] ?? '');
            $table = escapeId($input['table'] ?? '');
            $keyName = $input['key_name'] ?? '';
            if (!$db || !$table || !$keyName) throw new Exception("Missing parameters to drop index");

            $pdo->exec("USE `$db`");
            $safeKey = escapeId($keyName);
            $sql = ($keyName === 'PRIMARY') ? "ALTER TABLE `$table` DROP PRIMARY KEY" : "ALTER TABLE `$table` DROP INDEX `$safeKey`";
            $pdo->exec($sql);
            echo json_encode(['success' => true]);
            break;

        case 'save_column':
            $pdo = getDB();
            $db = escapeId($input['db'] ?? '');
            $table = escapeId($input['table'] ?? '');
            $isEdit = !empty($input['is_edit']);
            $oldName = !empty($input['old_name']) && $input['old_name'] !== 'null' ? escapeId($input['old_name']) : '';

            $colName = escapeId(trim($input['col_name'] ?? ''));
            $type = strtoupper(trim($input['col_type'] ?? 'VARCHAR'));
            if (!preg_match('/^[A-Z][A-Z ]*$/', $type)) throw new Exception('Invalid column type.');

            // These parts go into the statement as-is, so they must look like what they claim to be.
            $rawLen = trim((string)($input['col_length'] ?? ''));
            $length = '';
            if ($rawLen !== '') {
                $isList = in_array($type, ['ENUM', 'SET'], true);
                $okLen = $isList ? isQuotedValueList($rawLen) : preg_match('/^\d+(\s*,\s*\d+)?$/', $rawLen);
                if (!$okLen) {
                    throw new Exception($isList
                        ? "List the allowed values in single quotes, separated by commas, e.g. 'active','hidden'."
                        : 'Length must be a number like 255, or precision,scale like 12,4.');
                }
                $length = "($rawLen)";
            }

            // UNSIGNED belongs immediately after the type, but ON UPDATE
            // CURRENT_TIMESTAMP is only valid *after* the DEFAULT clause, so the
            // two attributes cannot share a slot in the definition.
            $rawAttr = strtoupper(trim($input['col_attr'] ?? ''));
            $attr = ($rawAttr === 'UNSIGNED') ? " UNSIGNED" : "";
            $onUpdate = ($rawAttr === 'ON UPDATE CURRENT_TIMESTAMP') ? " ON UPDATE CURRENT_TIMESTAMP" : "";

            $rawColl = trim((string)($input['col_collation'] ?? ''));
            if ($rawColl !== '' && !preg_match('/^[A-Za-z0-9_]+$/', $rawColl)) throw new Exception('Invalid collation name.');
            $collation = $rawColl !== '' ? " COLLATE $rawColl" : '';
            $isNull = !empty($input['is_null']) ? " NULL" : " NOT NULL";
            $ai = (!empty($input['is_ai'])) ? " AUTO_INCREMENT" : "";
            $comment = !empty($input['col_comment']) ? " COMMENT " . $pdo->quote($input['col_comment']) : "";
            $rawPos = trim((string)($input['col_position'] ?? ''));
            if ($rawPos !== '' && !preg_match('/^(FIRST|AFTER `(?:[^`]|``)+`)$/', $rawPos)) throw new Exception('Invalid column position.');
            $position = $rawPos !== '' ? " $rawPos" : '';

            // Default value logic
            $default = "";
            if (($input['def_type'] ?? '') === 'USER_DEFINED') {
                $default = " DEFAULT " . $pdo->quote($input['def_val'] ?? '');
            } elseif (($input['def_type'] ?? '') === 'CURRENT_TIMESTAMP') {
                $default = " DEFAULT CURRENT_TIMESTAMP";
            } elseif (($input['def_type'] ?? '') === 'NULL' && !empty($input['is_null'])) {
                $default = " DEFAULT NULL";
            }

            if (!$db || !$table) throw new Exception("Database and table name are required.");
            if (!$colName) throw new Exception("Column name is required.");

            $colDef = "`$colName` $type$length$attr$collation$isNull$default$onUpdate$ai$comment$position";

            $pdo->exec("USE `$db`");
            if ($isEdit && $oldName) {
                $pdo->exec("ALTER TABLE `$table` CHANGE `$oldName` $colDef");
            } else {
                $pdo->exec("ALTER TABLE `$table` ADD $colDef");
            }

            echo json_encode(['success' => true]);
            break;

        case 'check_session':
            if (!empty($_SESSION['db_host']) && !empty($_SESSION['db_user'])) {
                try {
                    $pdo = getDB();
                    echo json_encode([
                        'logged_in' => true,
                        'user' => $_SESSION['db_user'],
                        'host' => $_SESSION['db_host'] . ':' . ($_SESSION['db_port'] ?? '3306'),
                        'csrf' => $_SESSION['csrf_token']
                    ]);
                } catch (Exception $e) {
                    // Credentials no longer work: drop them but keep the session
                    // (and its CSRF token) so the login form can post again.
                    unset($_SESSION['db_host'], $_SESSION['db_port'], $_SESSION['db_user'], $_SESSION['db_pass'], $_SESSION['db_name']);
                    echo json_encode(['logged_in' => false, 'csrf' => $_SESSION['csrf_token']]);
                }
            } else {
                echo json_encode(['logged_in' => false, 'csrf' => $_SESSION['csrf_token']]);
            }
            break;

        case 'get_tables_status':
            $pdo = getDB();
            $rawDb = getParam('db', '');
            if (!$rawDb) throw new Exception('Database name is required');
            $db = escapeId($rawDb);
            $pdo->exec("USE `$db`");
            $types = tableTypes($pdo, $db);
            $stmt = $pdo->query("SHOW TABLE STATUS");
            $tables = [];
            while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
                // Views report a NULL engine. A healthy view has "VIEW" as its
                // comment; a broken one (missing definer, dropped table...) has
                // MySQL's error text there instead, which we pass on.
                $isView = ($types[$row['Name']] ?? '') === 'VIEW';
                $viewError = ($isView && ($row['Comment'] ?? '') !== 'VIEW') ? (string)$row['Comment'] : '';
                $tables[] = [
                    'name' => $row['Name'],
                    'type' => $isView ? 'VIEW' : 'TABLE',
                    'rows' => (int)($row['Rows'] ?? 0),
                    'size' => (int)($row['Data_length'] ?? 0) + (int)($row['Index_length'] ?? 0),
                    'data_length' => (int)($row['Data_length'] ?? 0),
                    'index_length' => (int)($row['Index_length'] ?? 0),
                    'auto_increment' => $row['Auto_increment'] !== null ? (int)$row['Auto_increment'] : null,
                    'engine' => $isView ? 'VIEW' : ($row['Engine'] ?? ''),
                    'collation' => $row['Collation'] ?? '',
                    'create_time' => $row['Create_time'] ?? null,
                    'update_time' => $row['Update_time'] ?? null,
                    'comment' => $isView ? '' : ($row['Comment'] ?? ''),
                    'view_error' => $viewError
                ];
            }
            echo json_encode(['success' => true, 'tables' => $tables]);
            break;

        case 'export':
            $pdo = getDB();
            $rawDb = getParam('db', '');
            if (!$rawDb) throw new Exception('Database name is required');
            $db = escapeId($rawDb);
            $pdo->exec("USE `$db`");

            $format = strtolower(getParam('format', 'sql'));
            $exportType = strtolower(getParam('export_type', 'all')); // 'all', 'structure', 'data'
            $addDropTable = filter_var(getParam('add_drop_table', true), FILTER_VALIDATE_BOOLEAN);
            $addCreateDb = filter_var(getParam('add_create_db', false), FILTER_VALIDATE_BOOLEAN);
            $disableFk = filter_var(getParam('disable_fk', true), FILTER_VALIDATE_BOOLEAN);
            $includeRoutines = filter_var(getParam('include_routines', true), FILTER_VALIDATE_BOOLEAN);
            $keepDefiner = filter_var(getParam('keep_definer', false), FILTER_VALIDATE_BOOLEAN);
            $download = (int)getParam('download', 0);

            $singleTable = getParam('table', '');
            $tablesParam = getParam('tables', null);
            $selectedTables = [];

            if (!empty($singleTable)) {
                $selectedTables = [$singleTable];
            } elseif (!empty($tablesParam)) {
                if (is_array($tablesParam)) {
                    $selectedTables = $tablesParam;
                } else {
                    $decoded = json_decode($tablesParam, true);
                    if (is_array($decoded)) {
                        $selectedTables = $decoded;
                    } else {
                        $selectedTables = array_filter(array_map('trim', explode(',', (string)$tablesParam)));
                    }
                }
            } else {
                $stmtT = $pdo->query("SHOW TABLES FROM `$db`");
                while ($tRow = $stmtT->fetch(PDO::FETCH_NUM)) {
                    $selectedTables[] = $tRow[0];
                }
            }

            if (empty($selectedTables)) {
                throw new Exception("No tables selected for export.");
            }

            $dateStr = date('Y-m-d_His');
            $baseName = $singleTable ? $singleTable : $rawDb;
            $filename = "{$baseName}_{$dateStr}.{$format}";
            $contentTypes = ['sql' => 'application/sql; charset=utf-8', 'csv' => 'text/csv; charset=utf-8', 'json' => 'application/json; charset=utf-8'];
            if (!isset($contentTypes[$format])) {
                throw new Exception("Unsupported export format: {$format}");
            }

            // Download: the file is streamed while it is built, so any size works.
            // Preview: built in memory and shown on the page, so it is capped.
            $previewCap = 20 * 1048576;
            $emit = null;
            $buf = '';
            if ($download === 1) {
                // Check the tables before the first byte goes out, so a mistake is still a readable error.
                $known = tableTypes($pdo, $db);
                foreach ($selectedTables as $t) {
                    if (!isset($known[$t])) throw new Exception("Table `{$t}` does not exist in `{$rawDb}`.");
                }
                $gzip = getParam('compress', '') === 'gzip';
                $emit = startDownload($filename, $contentTypes[$format], (string)getParam('token', ''), $gzip);
            }
            $write = function ($s) use (&$emit, &$buf, $previewCap) {
                if ($emit) {
                    $emit($s);
                    return;
                }
                $buf .= $s;
                if (strlen($buf) > $previewCap) {
                    throw new Exception('This export is too big to preview (over 20 MB). Use Download instead.');
                }
            };
            $totalRowsDumped = 0;

            try {
                if ($format === 'sql') {
                    [$sqlText, $totalRowsDumped] = buildSqlDump($pdo, $db, $rawDb, $selectedTables, [
                        'export_type' => $exportType,
                        'add_drop_table' => $addDropTable,
                        'add_create_db' => $addCreateDb,
                        'disable_fk' => $disableFk,
                        'include_routines' => $includeRoutines,
                        'keep_definer' => $keepDefiner,
                        'single_table' => $singleTable,
                        'emit' => $emit,
                        'max_bytes' => $previewCap,
                    ]);
                    if (!$emit) $buf = $sqlText;
                } elseif ($format === 'csv') {
                    $write("\xEF\xBB\xBF"); // UTF-8 BOM, so Excel reads Khmer/Unicode text correctly
                    $many = count($selectedTables) > 1;
                    $fp = fopen('php://temp', 'r+');
                    // fputcsv writes to a scratch stream; its contents are passed on every ~1 MB.
                    $drain = function ($force = false) use ($fp, $write) {
                        if (!$force && ftell($fp) < 1048576) return;
                        rewind($fp);
                        $s = stream_get_contents($fp);
                        ftruncate($fp, 0);
                        rewind($fp);
                        if ($s !== '') $write($s);
                    };
                    foreach ($selectedTables as $t) {
                        if ($many) fputcsv($fp, ["# TABLE: {$t}"], ',', '"', '\\');
                        $pdo->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, false);
                        $stmt = $pdo->query("SELECT * FROM `" . escapeId($t) . "`");
                        try {
                            $cols = [];
                            for ($i = 0; $i < $stmt->columnCount(); $i++) $cols[] = $stmt->getColumnMeta($i)['name'];
                            if ($cols) fputcsv($fp, $cols, ',', '"', '\\');
                            while ($row = $stmt->fetch(PDO::FETCH_NUM)) {
                                $totalRowsDumped++;
                                fputcsv($fp, $row, ',', '"', '\\');
                                $drain();
                            }
                        } finally {
                            $stmt->closeCursor();
                            $pdo->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, true);
                        }
                        if ($many) fwrite($fp, "\r\n");
                        $drain(true);
                    }
                    fclose($fp);
                } else { // json
                    $flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE;
                    $writeRows = function ($t) use ($pdo, $write, &$totalRowsDumped, $flags) {
                        $pdo->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, false);
                        $stmt = $pdo->query("SELECT * FROM `" . escapeId($t) . "`");
                        try {
                            $piece = '[';
                            $first = true;
                            while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
                                $totalRowsDumped++;
                                $piece .= ($first ? "\n  " : ",\n  ") . json_encode($row, $flags);
                                $first = false;
                                if (strlen($piece) >= 1048576) {
                                    $write($piece);
                                    $piece = '';
                                }
                            }
                            $write($piece . ($first ? ']' : "\n]"));
                        } finally {
                            $stmt->closeCursor();
                            $pdo->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, true);
                        }
                    };
                    if ($singleTable) {
                        $writeRows($singleTable);
                        $write("\n");
                    } else {
                        $write('{"database": ' . json_encode((string)$rawDb, $flags) . ', "tables": {');
                        foreach (array_values($selectedTables) as $i => $t) {
                            $write(($i ? ",\n" : "\n") . json_encode((string)$t, $flags) . ': ');
                            $writeRows($t);
                        }
                        $write("\n}}\n");
                    }
                }
            } catch (Throwable $e) {
                if (!$emit) throw ($e instanceof Exception ? $e : new Exception($e->getMessage()));
                // The download has already started, so the error can only go into the file itself.
                error_log('DBManager export stopped: ' . $e->getMessage());
                $emit("\n\n-- EXPORT STOPPED, THIS FILE IS INCOMPLETE: " . str_replace(["\r", "\n"], ' ', $e->getMessage()) . "\n");
                exit;
            }
            if ($emit) exit;

            echo json_encode([
                'success' => true,
                'filename' => $filename,
                'content' => $buf,
                'size' => strlen($buf),
                'tables_count' => count($selectedTables),
                'rows_count' => $totalRowsDumped
            ]);
            break;

        case 'import_preview':
            $format = strtolower(getParam('format', ''));
            $content = '';

            if (isset($_FILES['file']) && is_uploaded_file($_FILES['file']['tmp_name'])) {
                [$content, $upName] = readUploadedFile();
                if (!$format) {
                    $ext = strtolower(pathinfo($upName, PATHINFO_EXTENSION));
                    if (in_array($ext, ['sql', 'csv', 'json'])) $format = $ext;
                }
            } else {
                $content = (string)getParam('raw_data', '');
            }

            if (!$format) $format = 'sql';
            if (empty($content)) {
                throw new Exception("No file or content provided for preview.");
            }

            if (substr($content, 0, 3) === "\xEF\xBB\xBF") {
                $content = substr($content, 3);
            }

            if ($format === 'sql') {
                $queries = splitSqlStatements($content);
                $preview = array_slice($queries, 0, 5);
                echo json_encode([
                    'success' => true,
                    'format' => 'sql',
                    'total_queries' => count($queries),
                    'preview' => $preview
                ]);
            } elseif ($format === 'csv') {
                $delimiter = getParam('delimiter', '');
                if (!$delimiter) {
                    // Auto-detect delimiter
                    $firstLine = strtok($content, "\r\n");
                    $counts = [
                        ',' => substr_count($firstLine, ','),
                        ';' => substr_count($firstLine, ';'),
                        "\t" => substr_count($firstLine, "\t"),
                        '|' => substr_count($firstLine, '|')
                    ];
                    arsort($counts);
                    $delimiter = key($counts) ?: ',';
                }

                $fp = fopen('php://memory', 'r+');
                fputs($fp, $content);
                rewind($fp);

                $headers = [];
                $rows = [];
                $rowCount = 0;
                while (($data = fgetcsv($fp, 0, $delimiter)) !== false) {
                    if ($rowCount === 0) {
                        $headers = $data;
                    } elseif (count($rows) < 8) {
                        $rows[] = $data;
                    }
                    $rowCount++;
                }
                fclose($fp);

                echo json_encode([
                    'success' => true,
                    'format' => 'csv',
                    'detected_delimiter' => $delimiter,
                    'headers' => $headers,
                    'preview_rows' => $rows,
                    'total_rows' => max(0, $rowCount - 1)
                ]);
            } elseif ($format === 'json') {
                $decoded = json_decode($content, true);
                if ($decoded === null) {
                    throw new Exception("Invalid JSON format.");
                }

                $isTableArray = is_array($decoded) && isset($decoded[0]) && is_array($decoded[0]);
                $isDbExport = is_array($decoded) && isset($decoded['database']) && isset($decoded['tables']);

                $preview = [];
                $headers = [];
                $total = 0;

                if ($isTableArray) {
                    $total = count($decoded);
                    $preview = array_slice($decoded, 0, 6);
                    $headers = array_keys($decoded[0]);
                } elseif ($isDbExport) {
                    $tables = array_keys($decoded['tables']);
                    $firstTable = $tables[0] ?? '';
                    if ($firstTable && !empty($decoded['tables'][$firstTable])) {
                        $total = count($decoded['tables'][$firstTable]);
                        $preview = array_slice($decoded['tables'][$firstTable], 0, 6);
                        $headers = array_keys($decoded['tables'][$firstTable][0] ?? []);
                    }
                }

                echo json_encode([
                    'success' => true,
                    'format' => 'json',
                    'headers' => $headers,
                    'preview' => $preview,
                    'total_items' => $total,
                    'is_db_export' => $isDbExport
                ]);
            }
            break;

        case 'import':
            $startTime = microtime(true);
            $pdo = getDB();
            $rawDb = getParam('db', '');
            if (!$rawDb) throw new Exception('Target database is required.');
            $db = escapeId($rawDb);
            $pdo->exec("USE `$db`");

            $rawTable = getParam('table', '');
            $table = $rawTable ? escapeId($rawTable) : '';

            $format = strtolower(getParam('format', ''));
            $content = '';
            $origFileName = '';

            if (isset($_FILES['file']) && is_uploaded_file($_FILES['file']['tmp_name'])) {
                [$content, $origFileName] = readUploadedFile();
                if (!$format) {
                    $ext = strtolower(pathinfo($origFileName, PATHINFO_EXTENSION));
                    if (in_array($ext, ['sql', 'csv', 'json'])) $format = $ext;
                }
            } else {
                $content = (string)getParam('raw_data', '');
            }

            if (!$format) $format = 'sql';
            if (empty($content)) {
                throw new Exception("No file or SQL content was uploaded to import.");
            }

            if (substr($content, 0, 3) === "\xEF\xBB\xBF") {
                $content = substr($content, 3);
            }

            if ($format === 'sql') {
                $disableFk = filter_var(getParam('disable_fk', true), FILTER_VALIDATE_BOOLEAN);
                $continueOnError = filter_var(getParam('continue_on_error', false), FILTER_VALIDATE_BOOLEAN);

                $run = runSqlScript($pdo, $content, $disableFk, $continueOnError);
                $queries = $run['queries'];
                $executed = $run['executed'];
                $affectedTotal = $run['affected'];
                $errors = $run['errors'];

                $duration = round((microtime(true) - $startTime) * 1000, 2);

                echo json_encode([
                    'success' => count($errors) === 0,
                    'format' => 'sql',
                    'queries_total' => count($queries),
                    'queries_executed' => $executed,
                    'rows_affected' => $affectedTotal,
                    'time_ms' => $duration,
                    'errors' => $errors
                ]);
            } elseif ($format === 'csv') {
                if (!$table) {
                    throw new Exception("Please select a target table to import CSV data into.");
                }

                $hasHeaders = filter_var(getParam('has_headers', true), FILTER_VALIDATE_BOOLEAN);
                $mode = getParam('mode', 'insert'); // 'insert', 'replace', 'truncate_insert'
                $delimiter = getParam('delimiter', ',');

                $fp = fopen('php://memory', 'r+');
                fputs($fp, $content);
                rewind($fp);

                // Fetch table columns
                $colsStmt = $pdo->query("SHOW COLUMNS FROM `$table`");
                $tableCols = [];
                while ($cRow = $colsStmt->fetch(PDO::FETCH_ASSOC)) {
                    $tableCols[] = $cRow['Field'];
                }

                if ($mode === 'truncate_insert') {
                    $pdo->exec("TRUNCATE TABLE `$table`");
                }

                $verb = ($mode === 'replace') ? 'REPLACE' : 'INSERT';

                $mappedCols = [];
                $firstRow = true;
                $rowCount = 0;
                $batch = [];
                $batchSize = 100;

                while (($row = fgetcsv($fp, 0, $delimiter)) !== false) {
                    if ($firstRow) {
                        $firstRow = false;
                        if ($hasHeaders) {
                            $mappedCols = [];
                            foreach ($row as $headerCol) {
                                $cleanH = trim((string)$headerCol);
                                $found = null;
                                foreach ($tableCols as $tc) {
                                    if (strcasecmp($tc, $cleanH) === 0) {
                                        $found = $tc;
                                        break;
                                    }
                                }
                                $mappedCols[] = $found ?: $cleanH;
                            }
                            continue;
                        } else {
                            $mappedCols = array_slice($tableCols, 0, count($row));
                        }
                    }

                    if (empty($row) || (count($row) === 1 && $row[0] === null)) continue;

                    $cleanRow = [];
                    foreach ($row as $cVal) {
                        $cleanRow[] = ($cVal === '' || $cVal === 'NULL') ? null : $cVal;
                    }

                    $batch[] = $cleanRow;
                    if (count($batch) >= $batchSize) {
                        $escapedCols = array_map(function($c) { return '`' . escapeId($c) . '`'; }, $mappedCols);
                        $colList = implode(', ', $escapedCols);

                        $placeholders = [];
                        $flatVals = [];
                        foreach ($batch as $bRow) {
                            $rowPh = [];
                            for ($i = 0; $i < count($mappedCols); $i++) {
                                $rowPh[] = '?';
                                $flatVals[] = $bRow[$i] ?? null;
                            }
                            $placeholders[] = '(' . implode(',', $rowPh) . ')';
                        }
                        $sql = "{$verb} INTO `$table` ({$colList}) VALUES " . implode(',', $placeholders);
                        $stmt = $pdo->prepare($sql);
                        $stmt->execute($flatVals);
                        $rowCount += count($batch);
                        $batch = [];
                    }
                }

                if (!empty($batch)) {
                    $escapedCols = array_map(function($c) { return '`' . escapeId($c) . '`'; }, $mappedCols);
                    $colList = implode(', ', $escapedCols);

                    $placeholders = [];
                    $flatVals = [];
                    foreach ($batch as $bRow) {
                        $rowPh = [];
                        for ($i = 0; $i < count($mappedCols); $i++) {
                            $rowPh[] = '?';
                            $flatVals[] = $bRow[$i] ?? null;
                        }
                        $placeholders[] = '(' . implode(',', $rowPh) . ')';
                    }
                    $sql = "{$verb} INTO `$table` ({$colList}) VALUES " . implode(',', $placeholders);
                    $stmt = $pdo->prepare($sql);
                    $stmt->execute($flatVals);
                    $rowCount += count($batch);
                }
                fclose($fp);

                $duration = round((microtime(true) - $startTime) * 1000, 2);
                echo json_encode([
                    'success' => true,
                    'format' => 'csv',
                    'rows_imported' => $rowCount,
                    'time_ms' => $duration
                ]);
            } elseif ($format === 'json') {
                $decoded = json_decode($content, true);
                if ($decoded === null) throw new Exception("Invalid JSON input.");

                $mode = getParam('mode', 'insert');
                $verb = ($mode === 'replace') ? 'REPLACE' : 'INSERT';
                $rowCount = 0;

                // Handle single table array or multiple tables object
                if (is_array($decoded) && isset($decoded[0]) && is_array($decoded[0])) {
                    if (!$table) {
                        throw new Exception("Please select a target table to import JSON data into.");
                    }
                    if ($mode === 'truncate_insert') {
                        $pdo->exec("TRUNCATE TABLE `$table`");
                    }

                    $cols = array_keys($decoded[0]);
                    $escapedCols = array_map(function($c) { return '`' . escapeId($c) . '`'; }, $cols);
                    $colList = implode(', ', $escapedCols);

                    $chunks = array_chunk($decoded, 100);
                    foreach ($chunks as $chunk) {
                        $placeholders = [];
                        $flatVals = [];
                        foreach ($chunk as $r) {
                            $rowPh = [];
                            foreach ($cols as $c) {
                                $rowPh[] = '?';
                                $val = $r[$c] ?? null;
                                if (is_array($val)) $val = json_encode($val);
                                $flatVals[] = $val;
                            }
                            $placeholders[] = '(' . implode(',', $rowPh) . ')';
                        }
                        $sql = "{$verb} INTO `$table` ({$colList}) VALUES " . implode(',', $placeholders);
                        $stmt = $pdo->prepare($sql);
                        $stmt->execute($flatVals);
                        $rowCount += count($chunk);
                    }
                } elseif (is_array($decoded) && isset($decoded['tables'])) {
                    // DB dump object
                    foreach ($decoded['tables'] as $tName => $tRows) {
                        if (!is_array($tRows) || empty($tRows)) continue;
                        $tSafe = escapeId($tName);
                        if ($mode === 'truncate_insert') {
                            $pdo->exec("TRUNCATE TABLE `$tSafe`");
                        }
                        $cols = array_keys($tRows[0]);
                        $escapedCols = array_map(function($c) { return '`' . escapeId($c) . '`'; }, $cols);
                        $colList = implode(', ', $escapedCols);

                        $chunks = array_chunk($tRows, 100);
                        foreach ($chunks as $chunk) {
                            $placeholders = [];
                            $flatVals = [];
                            foreach ($chunk as $r) {
                                $rowPh = [];
                                foreach ($cols as $c) {
                                    $rowPh[] = '?';
                                    $val = $r[$c] ?? null;
                                    if (is_array($val)) $val = json_encode($val);
                                    $flatVals[] = $val;
                                }
                                $placeholders[] = '(' . implode(',', $rowPh) . ')';
                            }
                            $sql = "{$verb} INTO `$tSafe` ({$colList}) VALUES " . implode(',', $placeholders);
                            $stmt = $pdo->prepare($sql);
                            $stmt->execute($flatVals);
                            $rowCount += count($chunk);
                        }
                    }
                } else {
                    throw new Exception("Unrecognized JSON format. Expected array of row objects or database dump object.");
                }

                $duration = round((microtime(true) - $startTime) * 1000, 2);
                echo json_encode([
                    'success' => true,
                    'format' => 'json',
                    'rows_imported' => $rowCount,
                    'time_ms' => $duration
                ]);
            }
            break;

        case 'create_table':
            // Like Navicat's "New Table": create it with an id primary key, then
            // the frontend opens the Structure tab to add the real columns.
            $pdo = getDB();
            $db = escapeId($input['db'] ?? '');
            if (!$db) throw new Exception('Database name is required.');
            $name = escapeId(validTableName($input['name'] ?? ''));
            $comment = trim((string)($input['comment'] ?? ''));
            $pdo->exec("USE `$db`");
            $pdo->exec("CREATE TABLE `$name` (\n"
                . "  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,\n"
                . "  PRIMARY KEY (`id`)\n"
                . ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
                . ($comment !== '' ? ' COMMENT=' . $pdo->quote($comment) : ''));
            echo json_encode(['success' => true]);
            break;

        case 'rename_table':
            // RENAME TABLE works for views too.
            $pdo = getDB();
            $db = escapeId($input['db'] ?? '');
            $old = escapeId($input['old_name'] ?? '');
            if (!$db || !$old) throw new Exception('Database and table name are required.');
            $new = escapeId(validTableName($input['new_name'] ?? ''));
            $pdo->exec("USE `$db`");
            $pdo->exec("RENAME TABLE `$old` TO `$new`");
            echo json_encode(['success' => true]);
            break;

        case 'duplicate_table':
            $pdo = getDB();
            $rawDb = $input['db'] ?? '';
            $db = escapeId($rawDb);
            $rawSource = $input['source'] ?? '';
            $source = escapeId($rawSource);
            if (!$db || !$source) throw new Exception('Database and source table are required.');
            $target = escapeId(validTableName($input['new_name'] ?? ''));
            $withData = !empty($input['with_data']);
            $pdo->exec("USE `$db`");

            if ((tableTypes($pdo, $db)[$rawSource] ?? '') === 'VIEW') {
                throw new Exception('Views cannot be duplicated. Open the view in the SQL tab and run its definition under a new name instead.');
            }

            // LIKE copies columns, indexes and AUTO_INCREMENT settings (not FKs or triggers).
            $pdo->exec("CREATE TABLE `$target` LIKE `$source`");
            $copied = 0;
            if ($withData) {
                // Generated columns can't be written to, so list the real ones explicitly.
                $colStmt = $pdo->prepare("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND EXTRA NOT LIKE '%GENERATED%' ORDER BY ORDINAL_POSITION");
                $colStmt->execute([$rawDb, $rawSource]);
                $cols = array_map(function ($c) { return '`' . escapeId($c) . '`'; }, $colStmt->fetchAll(PDO::FETCH_COLUMN));
                if ($cols) {
                    $colSql = implode(', ', $cols);
                    $copied = $pdo->exec("INSERT INTO `$target` ($colSql) SELECT $colSql FROM `$source`");
                }
            }
            echo json_encode(['success' => true, 'rows_copied' => (int)$copied]);
            break;

        case 'truncate_tables':
            // "Empty table". FK checks are off for the duration so a parent table
            // can be emptied; MySQL otherwise refuses to TRUNCATE any table that
            // another table references, even when the child is already empty.
            $pdo = getDB();
            $db = escapeId($input['db'] ?? '');
            if (!$db) throw new Exception('Database name is required.');
            $list = tableListParam($input);
            $pdo->exec("USE `$db`");
            $types = tableTypes($pdo, $db);

            $done = [];
            $errors = [];
            $pdo->exec("SET FOREIGN_KEY_CHECKS = 0");
            try {
                foreach ($list as $t) {
                    if (($types[$t] ?? '') === 'VIEW') {
                        $errors[] = ['table' => $t, 'error' => 'Views have no rows of their own to empty.'];
                        continue;
                    }
                    try {
                        $pdo->exec("TRUNCATE TABLE `" . escapeId($t) . "`");
                        $done[] = $t;
                    } catch (Exception $e) {
                        $errors[] = ['table' => $t, 'error' => $e->getMessage()];
                    }
                }
            } finally {
                $pdo->exec("SET FOREIGN_KEY_CHECKS = 1");
            }
            echo json_encode(['success' => empty($errors), 'done' => $done, 'errors' => $errors]);
            break;

        case 'drop_tables':
            $pdo = getDB();
            $db = escapeId($input['db'] ?? '');
            if (!$db) throw new Exception('Database name is required.');
            $list = tableListParam($input);
            $pdo->exec("USE `$db`");
            $types = tableTypes($pdo, $db);

            // Foreign keys stay enforced, so a table still referenced by a table
            // outside the selection is refused rather than silently orphaned.
            // Within the selection, order doesn't matter: anything blocked by a
            // child that is also being dropped is retried after that child goes.
            $pending = $list;
            $done = [];
            $lastErrors = [];
            do {
                $progress = false;
                $lastErrors = [];
                foreach ($pending as $i => $t) {
                    $kind = ($types[$t] ?? '') === 'VIEW' ? 'VIEW' : 'TABLE';
                    try {
                        $pdo->exec("DROP {$kind} `" . escapeId($t) . "`");
                        $done[] = $t;
                        unset($pending[$i]);
                        $progress = true;
                    } catch (Exception $e) {
                        $lastErrors[] = ['table' => $t, 'error' => $e->getMessage()];
                    }
                }
            } while ($progress && $pending);

            echo json_encode(['success' => empty($lastErrors), 'done' => $done, 'errors' => $lastErrors]);
            break;

        case 'db_objects':
            // Everything in a database that isn't a table or view, for the sidebar.
            $pdo = getDB();
            $rawDb = $_GET['db'] ?? '';
            if ($rawDb === '') throw new Exception('Database name is required.');

            $stmt = $pdo->prepare("SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, DTD_IDENTIFIER AS returns
                FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME");
            $stmt->execute([$rawDb]);
            $routines = $stmt->fetchAll(PDO::FETCH_ASSOC);

            $stmt = $pdo->prepare("SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS `table`, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event
                FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME");
            $stmt->execute([$rawDb]);
            $triggers = $stmt->fetchAll(PDO::FETCH_ASSOC);

            $events = [];
            try {
                $stmt = $pdo->prepare("SELECT EVENT_NAME AS name, STATUS AS status FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME");
                $stmt->execute([$rawDb]);
                $events = $stmt->fetchAll(PDO::FETCH_ASSOC);
            } catch (Exception $e) {
                // Listing events needs the EVENT privilege; show none rather than fail.
            }
            echo json_encode(['success' => true, 'routines' => $routines, 'triggers' => $triggers, 'events' => $events]);
            break;

        case 'show_create':
            $pdo = getDB();
            $rawDb = $_GET['db'] ?? '';
            $name = $_GET['name'] ?? '';
            $kinds = ['procedure' => 'Create Procedure', 'function' => 'Create Function', 'trigger' => 'SQL Original Statement',
                      'event' => 'Create Event', 'view' => 'Create View', 'table' => 'Create Table'];
            $kind = strtolower($_GET['kind'] ?? '');
            if ($rawDb === '' || $name === '' || !isset($kinds[$kind])) throw new Exception('Database, kind and name are required.');
            $pdo->exec("USE `" . escapeId($rawDb) . "`");
            $row = $pdo->query("SHOW CREATE " . strtoupper($kind) . " `" . escapeId($name) . "`")->fetch(PDO::FETCH_ASSOC);
            if (empty($row[$kinds[$kind]])) {
                throw new Exception("Can't read the definition of $kind \"$name\" (you may lack the privilege).");
            }
            echo json_encode(['success' => true, 'sql' => $row[$kinds[$kind]]]);
            break;

        case 'structure_info':
            // Everything the Structure tab shows besides columns and indexes.
            $pdo = getDB();
            $rawDb = $_GET['db'] ?? '';
            $rawTable = $_GET['table'] ?? '';
            if ($rawDb === '' || $rawTable === '') throw new Exception('Database and table are required.');
            $pdo->exec("USE `" . escapeId($rawDb) . "`");

            $st = $pdo->prepare("SHOW TABLE STATUS WHERE Name = ?");
            $st->execute([$rawTable]);
            $s = $st->fetch(PDO::FETCH_ASSOC) ?: [];

            $createRow = $pdo->query("SHOW CREATE TABLE `" . escapeId($rawTable) . "`")->fetch(PDO::FETCH_ASSOC) ?: [];
            $createSql = $createRow['Create Table'] ?? ($createRow['Create View'] ?? '');

            $fkSql = "SELECT k.CONSTRAINT_NAME AS name, k.TABLE_SCHEMA AS `schema`, k.TABLE_NAME AS tbl, k.COLUMN_NAME AS col,
                        k.REFERENCED_TABLE_SCHEMA AS ref_schema, k.REFERENCED_TABLE_NAME AS ref_table, k.REFERENCED_COLUMN_NAME AS ref_col,
                        r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete
                      FROM information_schema.KEY_COLUMN_USAGE k
                      JOIN information_schema.REFERENTIAL_CONSTRAINTS r
                        ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
                      WHERE %s
                      ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION";
            $q = $pdo->prepare(sprintf($fkSql, "k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL"));
            $q->execute([$rawDb, $rawTable]);
            $fks = groupForeignKeys($q->fetchAll(PDO::FETCH_ASSOC));
            $q = $pdo->prepare(sprintf($fkSql, "k.REFERENCED_TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ?"));
            $q->execute([$rawDb, $rawTable]);
            $referencedBy = groupForeignKeys($q->fetchAll(PDO::FETCH_ASSOC));

            echo json_encode([
                'success' => true,
                'status' => [
                    'engine' => $s['Engine'] ?? null,
                    'rows' => isset($s['Rows']) ? (int)$s['Rows'] : null,
                    'data_length' => (int)($s['Data_length'] ?? 0),
                    'index_length' => (int)($s['Index_length'] ?? 0),
                    'auto_increment' => isset($s['Auto_increment']) ? (int)$s['Auto_increment'] : null,
                    'collation' => $s['Collation'] ?? null,
                    'create_time' => $s['Create_time'] ?? null,
                    'update_time' => $s['Update_time'] ?? null,
                    'comment' => $s['Comment'] ?? ''
                ],
                'create_sql' => $createSql,
                'foreign_keys' => $fks,
                'referenced_by' => $referencedBy
            ]);
            break;

        case 'table_columns':
            // Column list of any table (for picking the referenced column of a new foreign key).
            $pdo = getDB();
            $rawDb = $_GET['db'] ?? '';
            $rawTable = $_GET['table'] ?? '';
            if ($rawDb === '' || $rawTable === '') throw new Exception('Database and table are required.');
            $rows = $pdo->query("SHOW COLUMNS FROM `" . escapeId($rawDb) . "`.`" . escapeId($rawTable) . "`")->fetchAll(PDO::FETCH_ASSOC);
            echo json_encode(['success' => true, 'columns' => array_map(function ($r) {
                return ['name' => $r['Field'], 'type' => $r['Type'], 'key' => $r['Key'], 'null' => $r['Null'] === 'YES', 'extra' => $r['Extra']];
            }, $rows)]);
            break;

        case 'add_foreign_key':
            $pdo = getDB();
            $db = escapeId($input['db'] ?? '');
            $table = escapeId($input['table'] ?? '');
            $cols = array_values(array_filter((array)($input['columns'] ?? []), 'is_string'));
            $refTable = (string)($input['ref_table'] ?? '');
            $refCols = array_values(array_filter((array)($input['ref_columns'] ?? []), 'is_string'));
            $rules = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION', 'SET DEFAULT'];
            $onDelete = strtoupper((string)($input['on_delete'] ?? 'RESTRICT'));
            $onUpdate = strtoupper((string)($input['on_update'] ?? 'RESTRICT'));
            $name = trim((string)($input['name'] ?? ''));
            if (!$db || !$table || !$cols || $refTable === '' || count($cols) !== count($refCols)) {
                throw new Exception('Choose the column(s) and the table and column(s) they point to.');
            }
            if (!in_array($onDelete, $rules, true) || !in_array($onUpdate, $rules, true)) throw new Exception('Invalid ON DELETE / ON UPDATE rule.');
            if ($name !== '' && !preg_match('/^[A-Za-z0-9_]{1,64}$/', $name)) throw new Exception('Constraint names may use letters, digits and _ (max 64).');
            $q = function ($c) { return '`' . escapeId($c) . '`'; };
            $pdo->exec("USE `$db`");
            $pdo->exec("ALTER TABLE `$table` ADD " . ($name !== '' ? "CONSTRAINT `$name` " : '')
                . "FOREIGN KEY (" . implode(', ', array_map($q, $cols)) . ") REFERENCES " . $q($refTable)
                . " (" . implode(', ', array_map($q, $refCols)) . ") ON DELETE $onDelete ON UPDATE $onUpdate");
            echo json_encode(['success' => true]);
            break;

        case 'drop_foreign_key':
            $pdo = getDB();
            $db = escapeId($input['db'] ?? '');
            $table = escapeId($input['table'] ?? '');
            $name = (string)($input['name'] ?? '');
            if (!$db || !$table || $name === '') throw new Exception('Database, table and constraint name are required.');
            $pdo->exec("USE `$db`");
            $pdo->exec("ALTER TABLE `$table` DROP FOREIGN KEY `" . escapeId($name) . "`");
            echo json_encode(['success' => true]);
            break;

        case 'move_column':
            // Reorder a column without changing it: its exact definition from SHOW
            // CREATE TABLE is reused in ALTER TABLE ... MODIFY ... FIRST / AFTER.
            $pdo = getDB();
            $db = escapeId($input['db'] ?? '');
            $table = escapeId($input['table'] ?? '');
            $col = (string)($input['column'] ?? '');
            $after = (string)($input['after'] ?? ''); // '' = move to the top
            if (!$db || !$table || $col === '') throw new Exception('Database, table and column are required.');
            $pdo->exec("USE `$db`");
            $create = $pdo->query("SHOW CREATE TABLE `$table`")->fetch(PDO::FETCH_ASSOC)['Create Table'] ?? '';
            $def = columnDefinition($create, $col);
            if ($def === null) throw new Exception("Column \"$col\" was not found.");
            $pos = $after === '' ? 'FIRST' : 'AFTER `' . escapeId($after) . '`';
            $pdo->exec("ALTER TABLE `$table` MODIFY COLUMN `" . escapeId($col) . "` $def $pos");
            echo json_encode(['success' => true]);
            break;

        case 'fix_view_definer':
            // A view runs with its creator's ("definer's") rights. When that MySQL
            // user doesn't exist on this server (common after importing a dump from
            // elsewhere), every query on the view fails with error 1449. Recreate
            // the view unchanged, but owned by the user who is logged in now.
            $pdo = getDB();
            $rawDb = $input['db'] ?? '';
            $view = $input['view'] ?? '';
            if ($rawDb === '' || $view === '') throw new Exception('Database and view name are required.');
            $pdo->exec("USE `" . escapeId($rawDb) . "`");
            if ((tableTypes($pdo, escapeId($rawDb))[$view] ?? '') !== 'VIEW') {
                throw new Exception("\"$view\" is not a view.");
            }
            $row = $pdo->query("SHOW CREATE VIEW `" . escapeId($view) . "`")->fetch(PDO::FETCH_ASSOC);
            if (empty($row['Create View'])) throw new Exception("Can't read the definition of view \"$view\".");
            // Without a DEFINER clause MySQL makes the current user the definer.
            $sql = preg_replace('/^\s*CREATE\s+/i', 'CREATE OR REPLACE ', stripDefiner($row['Create View']), 1);
            $pdo->exec($sql);
            $owner = $pdo->query("SELECT CURRENT_USER()")->fetchColumn();
            echo json_encode(['success' => true, 'definer' => $owner]);
            break;

        case 'drop_object':
            $pdo = getDB();
            $rawDb = $input['db'] ?? '';
            $name = $input['name'] ?? '';
            $kind = strtoupper($input['kind'] ?? '');
            if ($rawDb === '' || $name === '' || !in_array($kind, ['PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT'], true)) {
                throw new Exception('Database, kind and name are required.');
            }
            $pdo->exec("USE `" . escapeId($rawDb) . "`");
            $pdo->exec("DROP $kind `" . escapeId($name) . "`");
            echo json_encode(['success' => true]);
            break;

        case 'backup_list':
            getDB(); // must be logged in
            $rawDb = $_GET['db'] ?? '';
            if ($rawDb === '') throw new Exception('Database name is required.');
            $dir = backupDirFor($rawDb);
            $files = [];
            foreach (glob($dir . DIRECTORY_SEPARATOR . '*.sql') ?: [] as $path) {
                $file = basename($path);
                if (!preg_match('/^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})/', $file, $m)) continue;
                $files[] = ['file' => $file, 'size' => filesize($path), 'created' => "{$m[1]} {$m[2]}:{$m[3]}:{$m[4]}"];
            }
            usort($files, function ($a, $b) { return strcmp($b['file'], $a['file']); });
            echo json_encode(['success' => true, 'backups' => $files, 'dir' => $dir]);
            break;

        case 'backup_create':
            // Full dump: structure, data, views, triggers, routines, events.
            $pdo = getDB();
            $rawDb = $input['db'] ?? '';
            if ($rawDb === '') throw new Exception('Database name is required.');
            $db = escapeId($rawDb);
            $pdo->exec("USE `$db`");
            $tables = array_keys(tableTypes($pdo, $db));

            $dir = backupDirFor($rawDb);
            if (!is_dir($dir) && !@mkdir($dir, 0700, true)) {
                throw new Exception("Can't create the backup folder $dir. Check it is writable, or change BACKUP_DIR in php/api.php.");
            }
            $base = date('Y-m-d_His');
            $file = "$base.sql";
            for ($n = 2; file_exists($dir . DIRECTORY_SEPARATOR . $file); $n++) $file = "{$base}_$n.sql";
            $path = $dir . DIRECTORY_SEPARATOR . $file;
            $fh = @fopen($path, 'xb');
            if (!$fh) throw new Exception("Can't write the backup to $dir.");

            // Written to the file piece by piece, so big databases don't run out of memory.
            @set_time_limit(0);
            if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
            $size = 0;
            try {
                [, $rows] = buildSqlDump($pdo, $db, $rawDb, $tables, [
                    'export_type' => 'all',
                    'add_drop_table' => true,
                    'add_create_db' => false,
                    'disable_fk' => true,
                    'include_routines' => true,
                    'keep_definer' => false,
                    'single_table' => '',
                    'emit' => function ($chunk) use ($fh, &$size, $dir) {
                        if (fwrite($fh, $chunk) === false) throw new Exception("Can't write the backup to $dir (disk full?).");
                        $size += strlen($chunk);
                    },
                ]);
                fclose($fh);
            } catch (Throwable $e) {
                fclose($fh);
                @unlink($path); // never leave a half-written backup that looks complete
                throw ($e instanceof Exception ? $e : new Exception($e->getMessage()));
            }
            echo json_encode(['success' => true, 'file' => $file, 'size' => $size, 'tables' => count($tables), 'rows' => $rows]);
            break;

        case 'backup_download':
            getDB();
            $rawDb = $_GET['db'] ?? '';
            $file = $_GET['file'] ?? '';
            $path = backupFilePath($rawDb, $file);
            $downloadName = preg_replace('/[^A-Za-z0-9_.-]/', '_', $rawDb) . '_' . $file;
            @set_time_limit(0);
            if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
            while (ob_get_level() > 0) @ob_end_clean();
            header('Content-Type: application/sql; charset=utf-8');
            header('Content-Disposition: attachment; filename="' . $downloadName . '"');
            header('Content-Length: ' . filesize($path));
            readfile($path);
            exit;

        case 'backup_restore':
            // Runs the whole dump against the database (tables are dropped and recreated).
            $startTime = microtime(true);
            $pdo = getDB();
            $rawDb = $input['db'] ?? '';
            $path = backupFilePath($rawDb, $input['file'] ?? '');
            $pdo->exec("USE `" . escapeId($rawDb) . "`");
            $run = runSqlScript($pdo, file_get_contents($path), true, false);
            echo json_encode([
                'success' => count($run['errors']) === 0,
                'queries_total' => count($run['queries']),
                'queries_executed' => $run['executed'],
                'errors' => $run['errors'],
                'time_ms' => round((microtime(true) - $startTime) * 1000, 2)
            ]);
            break;

        case 'backup_delete':
            getDB();
            $rawDb = $input['db'] ?? '';
            $path = backupFilePath($rawDb, $input['file'] ?? '');
            if (!@unlink($path)) throw new Exception("Can't delete that backup file.");
            echo json_encode(['success' => true]);
            break;

        case 'logout':
            session_unset();
            session_destroy();
            echo json_encode(['success' => true]);
            break;

        default:
            throw new Exception('Invalid API action');
    }
} catch (Exception $e) {
    $code = $e->getCode();
    $isAuth = $code === 401;
    $status = in_array($code, [401, 429], true) ? $code : 500;
    http_response_code($status);
    echo json_encode([
        'success' => false,
        'error' => $e->getMessage(),
        'session_expired' => $isAuth
    ]);
}
