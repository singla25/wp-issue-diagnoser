<?php
if ( function_exists( 'mysql_select_db' ) ) {
	if ( $ok ) {
		mysql_select_db( 'd' );
	} else {
		mysql_select_db( 'd' );
	}
}
if ( ! function_exists( 'mysql_select_db' ) ) {
	$x = 1;
} else {
	if ( $ok ) {
		mysql_select_db( 'd' );
	}
}
if ( ! ( function_exists( 'mysql_select_db' ) && $ok ) ) {
	$x = 1;
} else {
	mysql_select_db( 'd' );
}
