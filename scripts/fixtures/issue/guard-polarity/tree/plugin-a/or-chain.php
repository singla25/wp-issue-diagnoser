<?php
if ( ! function_exists( 'mysql_query' ) || $off ) {
	$x = 1;
} else {
	mysql_query( 'q' );
}
if ( $off || ! function_exists( 'mysql_query' ) ) {
	$x = 1;
} else {
	mysql_query( 'q' );
}
if ( $ok || function_exists( 'mysql_query' ) ) {
	mysql_query( 'q' );
}
if ( function_exists( 'mysql_query' ) || function_exists( 'mysql_query' ) ) {
	mysql_query( 'q' );
}
