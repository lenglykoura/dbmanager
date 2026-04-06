<?php
// api.php
session_start();
header('Content-Type: application/json');

// Get JSON input for POST requests
$input = json_decode(file_get_contents('php://input'), true);
$action = $_GET['action'] ?? ($input['action'] ?? '');

// Helper to get PDO connection using stored session credentials
function getDB()
{
    if (empty($_SESSION['db_host'])) {
        throw new Exception('Not connected. Please log in.');
    }

    $dsn = "mysql:host=" . $_SESSION['db_host'] . ";port=" . $_SESSION['db_port'];
    if (!empty($_SESSION['db_name'])) {
        $dsn .= ";dbname=" . $_SESSION['db_name'];
    }

    // Create connection (using fetch assoc to make JSON encoding cleaner)
    $pdo = new PDO($dsn, $_SESSION['db_user'], $_SESSION['db_pass']);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

    return $pdo;
}

try {
    switch ($action) {
        case 'connect':
            $hostParts = explode(':', $input['host'] ?? 'localhost');
            $host = $hostParts[0];
            $port = $hostParts[1] ?? '3306';

            $_SESSION['db_host'] = $host;
            $_SESSION['db_port'] = $port;
            $_SESSION['db_user'] = $input['user'] ?? 'root';
            $_SESSION['db_pass'] = $input['password'] ?? '';
            $_SESSION['db_name'] = $input['database'] ?? '';

            // Test connection
            $pdo = getDB();
            echo json_encode(['success' => true, 'message' => 'Connected successfully']);
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
            $db = $_GET['db'] ?? '';
            $stmt = $pdo->query("SHOW TABLES FROM `$db`");
            $tables = [];
            while ($row = $stmt->fetch(PDO::FETCH_NUM)) {
                $tables[] = $row[0];
            }
            echo json_encode(['tables' => $tables]);
            break;

        case 'data':
            $pdo = getDB();
            $db = $_GET['db'] ?? '';
            $table = $_GET['table'] ?? '';

            // 1. Get Pagination, Filter, and Sort parameters from URL
            $page = isset($_GET['page']) ? (int)$_GET['page'] : 1;
            $perPage = isset($_GET['per_page']) ? (int)$_GET['per_page'] : 15;
            $offset = ($page - 1) * $perPage;

            $filters = isset($_GET['filters']) ? json_decode($_GET['filters'], true) : [];
            $sorts = isset($_GET['sorts']) ? json_decode($_GET['sorts'], true) : [];

            $pdo->exec("USE `$db` ");

            // 2. Build Dynamic WHERE Clause (Filtering)
            $whereParts = [];
            $params = [];
            foreach ($filters as $f) {
                if (!isset($f['active']) || !$f['active'] || empty($f['col']) || empty($f['op'])) continue;
                $col = $f['col'];
                $val = $f['val'];
                switch ($f['op']) {
                    case '=':
                        $whereParts[] = "`$col` = ?";
                        $params[] = $val;
                        break;
                    case '!=':
                        $whereParts[] = "`$col` != ?";
                        $params[] = $val;
                        break;
                    case 'contains':
                        $whereParts[] = "`$col` LIKE ?";
                        $params[] = "%$val%";
                        break;
                    case 'starts with':
                        $whereParts[] = "`$col` LIKE ?";
                        $params[] = "$val%";
                        break;
                    case 'ends with':
                        $whereParts[] = "`$col` LIKE ?";
                        $params[] = "%$val";
                        break;
                    case '>':
                        $whereParts[] = "`$col` > ?";
                        $params[] = $val;
                        break;
                    case '<':
                        $whereParts[] = "`$col` < ?";
                        $params[] = $val;
                        break;
                    case '>=':
                        $whereParts[] = "`$col` >= ?";
                        $params[] = $val;
                        break;
                    case '<=':
                        $whereParts[] = "`$col` <= ?";
                        $params[] = $val;
                        break;
                    case 'is null':
                        $whereParts[] = "`$col` IS NULL";
                        break;
                    case 'is not null':
                        $whereParts[] = "`$col` IS NOT NULL";
                        break;
                }
            }
            $whereSql = count($whereParts) > 0 ? "WHERE " . implode(" AND ", $whereParts) : "";

            // 3. Build Dynamic ORDER BY Clause (Sorting)
            $orderParts = [];
            foreach ($sorts as $s) {
                if (empty($s['col'])) continue;
                $dir = (isset($s['dir']) && strtoupper($s['dir']) === 'DESC') ? 'DESC' : 'ASC';
                $orderParts[] = "`{$s['col']}` $dir";
            }
            $orderSql = count($orderParts) > 0 ? "ORDER BY " . implode(", ", $orderParts) : "";

            // 4. Get total count for pagination UI
            $countStmt = $pdo->prepare("SELECT COUNT(*) FROM `$table` $whereSql");
            $countStmt->execute($params);
            $totalRows = (int)$countStmt->fetchColumn();

            // 5. Fetch Schema
            $stmtSchema = $pdo->query("SHOW FULL COLUMNS FROM `$table` ");
            $schema = $stmtSchema->fetchAll(PDO::FETCH_ASSOC);

            // 6. Fetch actual paginated, filtered, and sorted data
            $sqlData = "SELECT * FROM `$table` $whereSql $orderSql LIMIT $perPage OFFSET $offset";
            $stmtData = $pdo->prepare($sqlData);
            $stmtData->execute($params);
            $data = $stmtData->fetchAll(PDO::FETCH_ASSOC);

            // 7. Foreign Key Logic (Keep your existing FK logic here...)
            $fkStmt = $pdo->prepare("SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL");
            $fkStmt->execute([$db, $table]);
            $fks = $fkStmt->fetchAll(PDO::FETCH_ASSOC);
            $fkOptions = [];
            foreach ($fks as $fk) {
                $colName = $fk['COLUMN_NAME'];
                $refTable = $fk['REFERENCED_TABLE_NAME'];
                $refCol = $fk['REFERENCED_COLUMN_NAME'];
                $refColsStmt = $pdo->query("SHOW COLUMNS FROM `$refTable` ");
                $refCols = $refColsStmt->fetchAll(PDO::FETCH_ASSOC);
                $displayCol = $refCol;
                foreach ($refCols as $rc) {
                    if (in_array(strtolower($rc['Field']), ['name', 'title', 'label', 'description', 'email'])) {
                        $displayCol = $rc['Field'];
                        break;
                    }
                }
                $optsStmt = $pdo->query("SELECT `$refCol` as val, `$displayCol` as label FROM `$refTable` LIMIT 25");
                $fkOptions[$colName] = $optsStmt->fetchAll(PDO::FETCH_ASSOC);
            }

            // 8. Return everything including totalRows
            echo json_encode(['schema' => $schema, 'data' => $data, 'totalRows' => $totalRows, 'fks' => $fkOptions]);
            break;
        case 'update_cell':
            $pdo = getDB();
            $db = $input['db'];
            $table = $input['table'];
            $column = $input['column'];
            $value = $input['value'];
            $pk_col = $input['pk_col'];
            $pk_val = $input['pk_val'];

            if (!$db || !$table || !$column || !$pk_col) {
                throw new Exception("Missing parameters for update");
            }

            $pdo->exec("USE `$db`");
            $stmt = $pdo->prepare("UPDATE `$table` SET `$column` = ? WHERE `$pk_col` = ?");
            $stmt->execute([$value, $pk_val]);

            echo json_encode(['success' => true]);
            break;
        case 'delete_row':
            $pdo = getDB();
            $db = $input['db'];
            $table = $input['table'];
            $pk_col = $input['pk_col'];
            $pk_val = $input['pk_val'];

            $pdo->exec("USE `$db`");
            $stmt = $pdo->prepare("DELETE FROM `$table` WHERE `$pk_col` = ?");
            $stmt->execute([$pk_val]);

            echo json_encode(['success' => true]);
            break;

        case 'insert_row':
            $pdo = getDB();
            $db = $input['db'];
            $table = $input['table'];
            $data = $input['data']; // Associative array of column => value

            $pdo->exec("USE `$db`");

            $cols = array_keys($data);
            $vals = array_values($data);

            // Build the INSERT query dynamically safely
            $colNames = implode("`, `", $cols);
            $placeholders = implode(",", array_fill(0, count($cols), "?"));

            $stmt = $pdo->prepare("INSERT INTO `$table` (`$colNames`) VALUES ($placeholders)");
            $stmt->execute($vals);

            echo json_encode(['success' => true]);
            break;
        case 'add_column':
            $pdo = getDB();
            $db = $input['db'];
            $table = $input['table'];
            $colName = $input['col_name'];
            $colType = $input['col_type'];
            $isNull = $input['is_null'] ? 'NULL' : 'NOT NULL';

            // Handle default value safely
            $default = '';
            if (isset($input['default_val']) && $input['default_val'] !== '') {
                // Use PDO quote to safely escape the default string
                $default = " DEFAULT " . $pdo->quote($input['default_val']);
            }

            $pdo->exec("USE `$db`");
            $pdo->exec("ALTER TABLE `$table` ADD COLUMN `$colName` $colType $isNull $default");

            echo json_encode(['success' => true]);
            break;
        // api.php snippet
        case 'drop_column':
            $pdo = getDB();
            $db = $input['db']; // Ensure this matches the JSON sent from actions.js
            $table = $input['table'];
            $col = $input['col_name'];

            $pdo->exec("USE `$db`");
            $pdo->exec("ALTER TABLE `$table` DROP COLUMN `$col`");
            echo json_encode(['success' => true]);
            break;
        case 'add_index':
            $pdo = getDB();
            // Pull data from the JSON input body
            $db = $input['db'] ?? '';
            $table = $input['table'] ?? '';
            $col = $input['col_name'] ?? '';
            $type = $input['index_type'] ?? '';

            if (!$db || !$table || !$col) {
                throw new Exception("Missing required index parameters.");
            }

            $pdo->exec("USE `$db`");

            // Build the SQL based on the type
            if ($type === 'PRIMARY') {
                $sql = "ALTER TABLE `$table` ADD PRIMARY KEY (`$col`)";
            } elseif ($type === 'UNIQUE') {
                $sql = "ALTER TABLE `$table` ADD UNIQUE (`$col`)";
            } else {
                // For standard indexes, we provide a generated name
                $idxName = $col . "_idx_" . time();
                $sql = "ALTER TABLE `$table` ADD INDEX `$idxName` (`$col`)";
            }

            try {
                $pdo->exec($sql);
                echo json_encode(['success' => true]);
            } catch (PDOException $e) {
                http_response_code(400); // Send an error code
                echo json_encode(['success' => false, 'error' => $e->getMessage()]);
            }
            break;
        case 'edit_index':
            $pdo = getDB();
            $db = $input['db'] ?? '';
            $table = $input['table'] ?? '';
            $oldKey = $input['old_key_name'] ?? '';
            $newKey = $input['new_key_name'] ?? '';
            $col = $input['col_name'] ?? '';
            $type = $input['index_type'] ?? '';

            if (!$db || !$table || !$oldKey || !$col) {
                throw new Exception("Missing required edit index parameters.");
            }

            $pdo->exec("USE `$db`");

            // 1. Build the DROP command
            $dropSql = ($oldKey === 'PRIMARY') ? "DROP PRIMARY KEY" : "DROP INDEX `$oldKey`";

            // 2. Build the ADD command
            if ($type === 'PRIMARY') {
                $addSql = "ADD PRIMARY KEY (`$col`)";
            } elseif ($type === 'UNIQUE') {
                $idxName = $newKey ? $newKey : $col . "_idx_" . time();
                $addSql = "ADD UNIQUE `$idxName` (`$col`)";
            } else {
                $idxName = $newKey ? $newKey : $col . "_idx_" . time();
                $addSql = "ADD INDEX `$idxName` (`$col`)";
            }

            try {
                // Execute both simultaneously so the table is never left without an index
                $sql = "ALTER TABLE `$table` $dropSql, $addSql";
                $pdo->exec($sql);
                echo json_encode(['success' => true]);
            } catch (PDOException $e) {
                http_response_code(400);
                echo json_encode(['success' => false, 'error' => $e->getMessage()]);
            }
            break;
        case 'run_query':
            $pdo = getDB();
            $sql = $input['query'] ?? '';
            $db = $input['db'] ?? '';
            $page = isset($input['page']) ? (int)$input['page'] : 1;
            $perPage = isset($input['per_page']) ? (int)$input['per_page'] : 15;
            $offset = ($page - 1) * $perPage;

            if ($db) $pdo->exec("USE `$db`");

            // 1. Get total count by wrapping the user's query
            $cleanSql = rtrim(trim($sql), ';');
            $countSql = "SELECT COUNT(*) FROM ($cleanSql) AS _total";
            $totalRows = (int)$pdo->query($countSql)->fetchColumn();

            // 2. Fetch only the current page of data
            $pagedSql = "$cleanSql LIMIT $perPage OFFSET $offset";
            $stmt = $pdo->query($pagedSql);

            $data = [];
            $headers = [];
            if ($stmt->columnCount() > 0) {
                $data = $stmt->fetchAll(PDO::FETCH_NUM);
                for ($i = 0; $i < $stmt->columnCount(); $i++) {
                    $meta = $stmt->getColumnMeta($i);
                    $headers[] = $meta['name'];
                }
            }

            echo json_encode([
                'success' => true,
                'data' => $data,
                'headers' => $headers,
                'totalRows' => $totalRows // Send total count back to frontend
            ]);
            break;
        case 'get_indexes':
            $pdo = getDB();
            $db = $_GET['db'];
            $table = $_GET['table'];
            $pdo->exec("USE `$db`");
            $stmt = $pdo->query("SHOW INDEX FROM `$table`");
            echo json_encode(['indexes' => $stmt->fetchAll()]);
            break;

        case 'drop_index':
            $pdo = getDB();
            $db = $input['db'];
            $table = $input['table'];
            $keyName = $input['key_name'];
            $pdo->exec("USE `$db`");

            // Primary key is dropped differently in MySQL
            $sql = ($keyName === 'PRIMARY') ? "ALTER TABLE `$table` DROP PRIMARY KEY" : "ALTER TABLE `$table` DROP INDEX `$keyName`";
            $pdo->exec($sql);
            echo json_encode(['success' => true]);
            break;

        case 'save_column':
            $pdo = getDB();
            $db = $input['db'];
            $table = $input['table'];
            $isEdit = $input['is_edit'] ?? false;
            $oldName = $input['old_name'] ?? '';

            $colName = $input['col_name'];
            $type = $input['col_type'];
            // Add brackets only if length is provided
            $length = (!empty($input['col_length'])) ? "(" . $input['col_length'] . ")" : "";
            $attr = !empty($input['col_attr']) ? " " . $input['col_attr'] : "";
            $collation = !empty($input['col_collation']) ? " COLLATE " . $input['col_collation'] : "";
            $isNull = $input['is_null'] ? " NULL" : " NOT NULL";
            $ai = (!empty($input['is_ai']) && $input['is_ai']) ? " AUTO_INCREMENT" : "";
            $comment = !empty($input['col_comment']) ? " COMMENT " . $pdo->quote($input['col_comment']) : "";
            $position = !empty($input['col_position']) ? " " . $input['col_position'] : "";

            // Default Logic
            $default = "";
            if ($input['def_type'] === 'USER_DEFINED') {
                $default = " DEFAULT " . $pdo->quote($input['def_val']);
            } elseif ($input['def_type'] === 'CURRENT_TIMESTAMP') {
                $default = " DEFAULT CURRENT_TIMESTAMP";
            } elseif ($input['def_type'] === 'NULL' && $input['is_null']) {
                $default = " DEFAULT NULL";
            }

            // Construct the SQL
            $colDef = "`$colName` $type$length$attr$collation$isNull$default$ai$comment$position";

            $pdo->exec("USE `$db`");
            if ($isEdit) {
                // If editing, we use CHANGE old_name new_definition
                $pdo->exec("ALTER TABLE `$table` CHANGE `$oldName` $colDef");
            } else {
                // If adding, we use ADD definition
                $pdo->exec("ALTER TABLE `$table` ADD $colDef");
            }

            echo json_encode(['success' => true]);
            break;
        case 'query':
            $pdo = getDB();
            $sql = $input['sql'] ?? '';
            $db = $input['db'] ?? '';

            if ($db) {
                $pdo->exec("USE `$db`");
            }

            $start_time = microtime(true);
            $stmt = $pdo->query($sql);

            // Only attempt to fetch results if the query returns a result set (like SELECT)
            $results = [];
            if ($stmt->columnCount() > 0) {
                $results = $stmt->fetchAll();
            }
            $end_time = microtime(true);

            $timeMs = round(($end_time - $start_time) * 1000, 1);
            $rowCount = $stmt->rowCount();

            echo json_encode(['results' => $results, 'timeMs' => $timeMs, 'rowCount' => $rowCount]);
            break;

        case 'check_session':
            if (!empty($_SESSION['db_host']) && !empty($_SESSION['db_user'])) {
                echo json_encode([
                    'logged_in' => true,
                    'user' => $_SESSION['db_user'],
                    'host' => $_SESSION['db_host'] . ':' . $_SESSION['db_port']
                ]);
            } else {
                echo json_encode(['logged_in' => false]);
            }
            break;
        case 'logout':
            session_destroy();
            echo json_encode(['success' => true]);
            break;

        default:
            throw new Exception('Invalid action');
    }
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'error' => $e->getMessage()]);
}
